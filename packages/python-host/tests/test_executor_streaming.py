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
