"""Долгий ход не молчит и не висит: heartbeat AG-UI, keepalive A2A, таймауты relay (паритет TS)."""

import asyncio
from typing import Any

import pytest
from a2a.server.context import ServerCallContext
from a2a.server.request_handlers import DefaultRequestHandlerV2
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    Message,
    SendMessageRequest,
    TaskState,
)
from google.protobuf.json_format import MessageToDict, ParseDict

from ai37_agent_host import a2a_executor
from ai37_agent_host.a2a_progress import A2A_KEEPALIVE_S, A2aProgress
from ai37_agent_host.relay import RemoteA2aRequest, execute_remote_a2a
from ai37_agent_host.types import AgentRequest, AgentResult, NodeEvent


class _Updater:
    """TaskUpdater-шпион: копит вызовы публикации."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    async def start_work(self) -> None:
        self.calls.append(("start_work", None))

    async def update_status(self, state: Any, metadata: Any = None, **_: Any) -> None:
        self.calls.append(("update_status", metadata))

    async def add_artifact(self, **kwargs: Any) -> None:
        self.calls.append(("add_artifact", kwargs.get("append")))


def _keepalives(updater: _Updater) -> list[tuple[str, Any]]:
    return [c for c in updater.calls if c in (("start_work", None), ("update_status", None))]


async def test_keepalive_on_silence_and_not_between_events():
    assert A2A_KEEPALIVE_S == 20.0
    updater = _Updater()
    progress = A2aProgress(updater, "t", keepalive_s=0.05)  # type: ignore[arg-type]
    await asyncio.sleep(0.13)
    # Первый keepalive — start_work, дальше update_status(WORKING) без metadata.
    assert updater.calls[:2] == [("start_work", None), ("update_status", None)]
    # События чаще keepalive_s переносят срок: новых keepalive между ними нет.
    progress.emit(NodeEvent(node="шаг"))
    await asyncio.sleep(0)
    before = len(_keepalives(updater))
    for i in range(4):
        await asyncio.sleep(0.03)
        progress.emit(NodeEvent(node=f"шаг {i}"))
    await asyncio.sleep(0.01)
    assert len(_keepalives(updater)) == before
    await progress.finish()
    after_finish = len(updater.calls)
    await asyncio.sleep(0.12)
    assert len(updater.calls) == after_finish


async def test_no_keepalive_by_default():
    updater = _Updater()
    progress = A2aProgress(updater, "t")  # type: ignore[arg-type]
    await asyncio.sleep(0.05)
    await progress.finish()
    assert updater.calls == []


class _Silent:
    async def run(self, req: AgentRequest) -> AgentResult:
        await asyncio.sleep(0.25)
        return AgentResult(status="completed", message="готово")


def _card() -> AgentCard:
    return AgentCard(
        name="slow-agent",
        description="test",
        version="0.0.0",
        supported_interfaces=[AgentInterface(url="http://local/a2a", protocol_binding="JSONRPC")],
        capabilities=AgentCapabilities(streaming=True),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
    )


async def test_executor_streams_keepalive_while_handler_is_silent(monkeypatch):
    monkeypatch.setattr(a2a_executor, "A2A_KEEPALIVE_S", 0.1)
    handler = DefaultRequestHandlerV2(
        agent_executor=a2a_executor.HostExecutor(_Silent(), agent_text_modes=["text/plain"]),
        task_store=InMemoryTaskStore(),
        agent_card=_card(),
    )
    message = ParseDict(
        {"message_id": "m1", "role": "ROLE_USER", "parts": [{"text": "долгий вопрос"}]},
        Message(),
        ignore_unknown_fields=True,
    )
    working: list[dict[str, Any]] = []
    last: str | None = None
    async for event in handler.on_message_send_stream(
        SendMessageRequest(message=message), ServerCallContext(state={})
    ):
        # Обработчик отдаёт сами события (Task / TaskStatusUpdateEvent), а не StreamResponse.
        su = MessageToDict(event, preserving_proto_field_name=False)
        if "taskId" not in su or "status" not in su:
            continue
        last = su["status"]["state"]
        if last == TaskState.Name(TaskState.TASK_STATE_WORKING):
            working.append(su)
    assert len(working) >= 2
    assert all(not su.get("metadata") and not su["status"].get("message") for su in working)
    assert last == TaskState.Name(TaskState.TASK_STATE_COMPLETED)


def _sr(field: str, data: dict[str, Any]) -> Any:
    from a2a.types.a2a_pb2 import StreamResponse

    sr = StreamResponse()
    ParseDict(data, getattr(sr, field))
    return sr


def _working() -> Any:
    return _sr(
        "status_update",
        {"taskId": "t1", "contextId": "c", "status": {"state": "TASK_STATE_WORKING"}},
    )


def _done() -> Any:
    return _sr(
        "task",
        {
            "id": "t1",
            "contextId": "c",
            "status": {
                "state": "TASK_STATE_COMPLETED",
                "message": {"role": "ROLE_AGENT", "parts": [{"text": "итог"}]},
            },
        },
    )


class _Scheduled:
    """Клиент, который отдаёт события с паузой перед каждым."""

    def __init__(self, steps: list[tuple[float, Any]]) -> None:
        self._steps = steps
        self.closed = False

    async def send_message(self, request: Any, *, context: Any = None):
        try:
            for delay, event in self._steps:
                await asyncio.sleep(delay)
                yield event
        finally:
            self.closed = True


async def test_relay_keepalive_resets_idle_timer():
    client = _Scheduled([(0.05, _working())] * 3 + [(0.05, _done())])
    seen: list[Any] = []
    res = await execute_remote_a2a(
        client, RemoteA2aRequest(query="q", idle_timeout_ms=80), on_event=seen.append
    )
    assert res.state == "completed"
    assert res.text == "итог"
    assert seen == []  # keepalive наверх не поднимается


async def test_relay_idle_timeout_closes_stream():
    client = _Scheduled([(0.01, _working()), (0.5, _done())])
    with pytest.raises(TimeoutError, match="молчит дольше 60 мс"):
        await execute_remote_a2a(client, RemoteA2aRequest(query="q", idle_timeout_ms=60))
    assert client.closed


async def test_relay_request_timeout_caps_live_stream():
    client = _Scheduled([(0.02, _working()) for _ in range(20)])
    with pytest.raises(TimeoutError, match="не ответил за 150 мс"):
        await execute_remote_a2a(
            client, RemoteA2aRequest(query="q", idle_timeout_ms=100, request_timeout_ms=150)
        )


async def test_relay_without_timeouts_unchanged():
    client = _Scheduled([(0.0, _done())])
    res = await execute_remote_a2a(client, RemoteA2aRequest(query="q"))
    assert res.state == "completed"


async def test_agui_heartbeat_on_silence(monkeypatch):
    pytest.importorskip("ag_ui")
    from ai37_agent_host import agui

    assert agui.AGUI_HEARTBEAT_S == 15.0
    monkeypatch.setattr(agui, "AGUI_HEARTBEAT_S", 0.05)

    class _Slow:
        async def run(self, req: AgentRequest) -> AgentResult:
            await asyncio.sleep(0.13)
            return AgentResult(status="completed", message="ок")

    body = {"threadId": "t", "runId": "r", "messages": [{"role": "user", "content": "hi"}]}
    frames = [f async for f in agui._run_turn(_Slow(), body, ["text/plain"], None, None)]
    pings = [f for f in frames if f == ": ping\n\n"]
    assert len(pings) >= 2
    assert "RUN_FINISHED" in frames[-1]
