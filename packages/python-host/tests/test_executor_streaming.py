"""Регрессия на реальном потоковом консьюмере a2a-sdk (ActiveTask._run_consumer).

FakeEventQueue из test_executor.py лишь копит события и НЕ валидирует инвариант
«Task обязан быть заэнкьюен ДО первого TaskStatusUpdateEvent». Именно этот инвариант
проверяет потоковый путь DefaultRequestHandlerV2.on_message_send_stream, и именно он
падал в проде (InvalidAgentResponseError), пока execute() публиковал submitted-таск
через updater.submit() (== update_status(SUBMITTED)) вместо самого Task-события.

Этот тест гоняет HostExecutor через НАСТОЯЩИЙ handler+consumer и требует, чтобы поток
дошёл до терминального состояния без InvalidAgentResponseError.
"""

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

from ai37_agent_host.a2a_executor import HostExecutor
from ai37_agent_host.types import A2uiComponent, AgentRequest, AgentResult, NodeEvent


class _Completed:
    async def run(self, req: AgentRequest) -> AgentResult:
        # эмитим прогресс — на старом коде это вызывало start_work()/update_status ДО Task
        req.emit(NodeEvent(node="step1"))
        return AgentResult(
            status="completed",
            message="done",
            result={"ok": True},
            a2ui=[A2uiComponent(component="SimpleTable", props={"title": "T"})],
        )


def _agent_card() -> AgentCard:
    return AgentCard(
        name="test-agent",
        description="test",
        version="0.0.0",
        supported_interfaces=[
            AgentInterface(url="http://local/a2a", protocol_binding="JSONRPC")
        ],
        capabilities=AgentCapabilities(streaming=True),
        default_input_modes=["text/plain"],
        default_output_modes=["text/markdown", "text/plain"],
    )


def _message() -> Message:
    return ParseDict(
        {"message_id": "m1", "role": "ROLE_USER", "parts": [{"text": "проверь ИНН"}]},
        Message(),
        ignore_unknown_fields=True,
    )


async def _stream_states() -> list[str]:
    handler = DefaultRequestHandlerV2(
        agent_executor=HostExecutor(
            _Completed(), agent_text_modes=["text/markdown", "text/plain"]
        ),
        task_store=InMemoryTaskStore(),
        agent_card=_agent_card(),
    )
    params = SendMessageRequest(message=_message())
    context = ServerCallContext(state={})

    states: list[str] = []
    async for event in handler.on_message_send_stream(params, context):
        data = MessageToDict(event, preserving_proto_field_name=False)
        status = data.get("status")
        if isinstance(status, dict) and "state" in status:
            states.append(status["state"])
    return states


@pytest.mark.anyio
async def test_streaming_consumer_accepts_task_before_status_update():
    # На старом коде тут поднимался InvalidAgentResponseError:
    # «Agent should enqueue Task before TaskStatusUpdateEvent event».
    states = await _stream_states()
    assert states, "поток не отдал ни одного статус-события"
    assert states[0] == TaskState.Name(TaskState.TASK_STATE_SUBMITTED)
    assert states[-1] == TaskState.Name(TaskState.TASK_STATE_COMPLETED)


class _TwoStep:
    """input-required на первом ходу, completed — на resume (эмитит прогресс)."""

    def __init__(self) -> None:
        self.calls = 0

    async def run(self, req: AgentRequest) -> AgentResult:
        self.calls += 1
        if self.calls == 1:
            return AgentResult(status="input-required", message="уточните тип контрагента")
        # На resume эмитим прогресс (== update_status(WORKING)) ДО финала — на старом коде
        # клиентский стрим получал только status/artifact-update без Task-события.
        req.emit(NodeEvent(node="verify"))
        return AgentResult(status="completed", message="готово", result={"ok": True})


async def _resume_task_events() -> list[dict[str, Any]]:
    handler = DefaultRequestHandlerV2(
        agent_executor=HostExecutor(
            _TwoStep(), agent_text_modes=["text/markdown", "text/plain"]
        ),
        task_store=InMemoryTaskStore(),
        agent_card=_agent_card(),
    )
    # Шаг 1: первый ход → input-required, ловим id/contextId созданной задачи.
    task_id: str | None = None
    context_id: str | None = None
    async for event in handler.on_message_send_stream(
        SendMessageRequest(message=_message()), ServerCallContext(state={})
    ):
        data = MessageToDict(event, preserving_proto_field_name=False)
        task_id = task_id or data.get("id") or data.get("taskId")
        context_id = context_id or data.get("contextId")
    assert task_id, "шаг 1 не создал задачу"

    # Шаг 2: resume — сообщение ссылается на существующий task_id (+ contextId) → current_task
    # грузится из store, executor идёт resume-веткой.
    resume_msg = ParseDict(
        {
            "message_id": "m2",
            "role": "ROLE_USER",
            "task_id": task_id,
            "context_id": context_id or "",
            "parts": [{"text": "производитель"}],
        },
        Message(),
        ignore_unknown_fields=True,
    )
    events: list[dict[str, Any]] = []
    async for event in handler.on_message_send_stream(
        SendMessageRequest(message=resume_msg), ServerCallContext(state={})
    ):
        events.append(MessageToDict(event, preserving_proto_field_name=False))
    return events


@pytest.mark.anyio
async def test_resume_stream_emits_task_snapshot_for_client_consumer():
    # Регресс: на resume (current_task != None) executor НЕ публиковал Task-событие → клиентский
    # drainStream оркестратора получал только status/artifact-update и не собирал финал
    # («executeRemoteA2aStreaming: поток не дал финального Message/Task»). Второй клик «Проверить»
    # падал; успех приходил лишь через stale-retry-as-new-dialog.
    events = await _resume_task_events()
    # Task-событие: top-level `id` и НЕТ `taskId` (в отличие от status/artifact-update).
    task_events = [e for e in events if "id" in e and "taskId" not in e]
    assert task_events, "resume-стрим не содержит Task-события — клиент не соберёт финал"
    states = [
        e["status"]["state"]
        for e in events
        if isinstance(e.get("status"), dict) and "state" in e["status"]
    ]
    assert states and states[-1] == TaskState.Name(TaskState.TASK_STATE_COMPLETED)
