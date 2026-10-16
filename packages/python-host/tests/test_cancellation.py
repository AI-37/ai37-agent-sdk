"""Отмена хода (паритет TS): tasks/cancel → canceled, обрыв AG-UI и relay отменяют работу."""

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
    CancelTaskRequest,
    Message,
    SendMessageRequest,
)
from google.protobuf.json_format import MessageToDict, ParseDict

from ai37_agent_host.a2a_executor import HostExecutor
from ai37_agent_host.relay import RemoteA2aRequest, execute_remote_a2a
from ai37_agent_host.types import AgentRequest, AgentResult, NodeEvent


class _Waiting:
    def __init__(self, *, emit_step: bool = True) -> None:
        self.task_id: str | None = None
        self.cancelled = False
        self._emit_step = emit_step

    async def run(self, req: AgentRequest) -> AgentResult:
        self.task_id = req.input.task_id
        # Первое событие публикует задачу: по нему клиент и узнаёт id, который потом отменяет.
        if self._emit_step:
            req.emit(NodeEvent(node="старт"))
        try:
            await asyncio.sleep(5)
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return AgentResult(status="completed", message="не должно дойти")


def _card() -> AgentCard:
    return AgentCard(
        name="cancel-agent",
        description="test",
        version="0.0.0",
        supported_interfaces=[AgentInterface(url="http://local/a2a", protocol_binding="JSONRPC")],
        capabilities=AgentCapabilities(streaming=True),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
    )


async def test_tasks_cancel_marks_task_canceled_and_stops_handler():
    agent = _Waiting()
    handler = DefaultRequestHandlerV2(
        agent_executor=HostExecutor(agent, agent_text_modes=["text/plain"]),
        task_store=InMemoryTaskStore(),
        agent_card=_card(),
    )
    message = ParseDict(
        {"message_id": "m1", "role": "ROLE_USER", "parts": [{"text": "hi"}]},
        Message(),
        ignore_unknown_fields=True,
    )
    states: list[str] = []

    async def consume() -> None:
        async for event in handler.on_message_send_stream(
            SendMessageRequest(message=message), ServerCallContext(state={})
        ):
            status = MessageToDict(event).get("status")
            if isinstance(status, dict):
                states.append(status["state"])

    stream = asyncio.create_task(consume())
    await asyncio.sleep(0.2)
    assert agent.task_id
    canceled = await asyncio.wait_for(
        handler.on_cancel_task(CancelTaskRequest(id=agent.task_id), ServerCallContext(state={})),
        3,
    )
    await asyncio.wait_for(stream, 3)
    assert MessageToDict(canceled)["status"]["state"] == "TASK_STATE_CANCELED"
    assert agent.cancelled
    assert states[-1] == "TASK_STATE_CANCELED"


def _sr(field: str, data: dict[str, Any]) -> Any:
    from a2a.types.a2a_pb2 import StreamResponse

    sr = StreamResponse()
    ParseDict(data, getattr(sr, field))
    return sr


class _Endless:
    """Агент, который шлёт задачу и дальше только прогресс; запоминает tasks/cancel."""

    def __init__(self, fail_cancel: bool = False) -> None:
        self.cancels: list[str] = []
        self._fail = fail_cancel

    async def send_message(self, request: Any, *, context: Any = None):
        yield _sr(
            "task", {"id": "child-1", "contextId": "c", "status": {"state": "TASK_STATE_WORKING"}}
        )
        while True:
            await asyncio.sleep(0.02)
            yield _sr(
                "status_update",
                {"taskId": "child-1", "contextId": "c", "status": {"state": "TASK_STATE_WORKING"}},
            )

    async def cancel_task(self, request: Any, *, context: Any = None) -> Any:
        self.cancels.append(request.id)
        if self._fail:
            raise RuntimeError("старый хост: no-op")


async def test_relay_cancelled_by_caller_sends_tasks_cancel():
    client = _Endless()
    call = asyncio.create_task(execute_remote_a2a(client, RemoteA2aRequest(query="q")))
    await asyncio.sleep(0.07)
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    await asyncio.sleep(0.01)
    assert client.cancels == ["child-1"]


async def test_relay_deadline_sends_tasks_cancel_and_ignores_cancel_error():
    client = _Endless(fail_cancel=True)
    with pytest.raises(TimeoutError, match="не ответил за 80 мс"):
        await execute_remote_a2a(client, RemoteA2aRequest(query="q", request_timeout_ms=80))
    await asyncio.sleep(0.01)
    assert client.cancels == ["child-1"]


async def test_agui_client_disconnect_cancels_turn():
    pytest.importorskip("ag_ui")
    from ai37_agent_host import agui

    agent = _Waiting(emit_step=False)  # молчит: следующий кадр генератора — только по отмене
    body = {"threadId": "t", "runId": "r", "messages": [{"role": "user", "content": "hi"}]}
    gen = agui._run_turn(agent, body, ["text/plain"], None, None)
    await anext(gen)  # RUN_STARTED; ход запускается на следующем шаге генератора
    pending = asyncio.ensure_future(anext(gen))
    await asyncio.sleep(0.05)
    assert agent.task_id is not None
    # Starlette при обрыве отменяет задачу, которая читает генератор ответа, — то же руками.
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    assert agent.cancelled
