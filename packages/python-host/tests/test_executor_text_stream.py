"""Native answer streaming through the real A2A consumer, task store and relay."""

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest_asyncio
from a2a.server.context import ServerCallContext
from a2a.server.request_handlers import DefaultRequestHandlerV2
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    Message,
    SendMessageRequest,
    StreamResponse,
)
from google.protobuf.json_format import MessageToDict, ParseDict

from ai37_agent_host.a2a_executor import HostExecutor
from ai37_agent_host.relay import RemoteA2aRequest, execute_remote_a2a
from ai37_agent_host.types import (
    A2uiComponent,
    A2uiEvent,
    AgentHandler,
    AgentRequest,
    AgentResult,
    NodeEvent,
    ReasoningEvent,
    TextEvent,
    ToolEvent,
)


@pytest_asyncio.fixture(autouse=True)
async def _close_consumer_tasks():
    """The in-memory A2A handler has no application lifespan/shutdown hook."""
    initial = asyncio.all_tasks()
    yield
    pending = asyncio.all_tasks() - initial - {asyncio.current_task()}
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)


def _handler(agent: AgentHandler, store: InMemoryTaskStore) -> DefaultRequestHandlerV2:
    card = AgentCard(
        name="stream-test",
        description="test",
        version="0.0.0",
        supported_interfaces=[AgentInterface(url="http://local/a2a", protocol_binding="JSONRPC")],
        capabilities=AgentCapabilities(streaming=True),
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
    )
    return DefaultRequestHandlerV2(
        agent_executor=HostExecutor(agent), task_store=store, agent_card=card
    )


async def _stream(handler: DefaultRequestHandlerV2) -> AsyncIterator[dict[str, Any]]:
    message = ParseDict(
        {"messageId": "user-1", "role": "ROLE_USER", "parts": [{"text": "question"}]}, Message()
    )
    async for event in handler.on_message_send_stream(
        SendMessageRequest(message=message), ServerCallContext(state={})
    ):
        yield MessageToDict(event, preserving_proto_field_name=False)


async def _until_delta(stream: AsyncIterator[dict[str, Any]]) -> list[dict[str, Any]]:
    events = []
    while True:
        event = await asyncio.wait_for(anext(stream), timeout=2)
        events.append(event)
        if event.get("append") and event.get("artifact", {}).get("parts"):
            return events


def _answer_chunks(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [event for event in events if event.get("artifact", {}).get("name") == "answer"]


class _GateAgent:
    def __init__(self, gate: asyncio.Event, prefix: str = "first ") -> None:
        self.gate = gate
        self.prefix = prefix
        self.finished = False

    async def run(self, req: AgentRequest) -> AgentResult:
        req.emit(TextEvent(delta=""))
        req.emit(TextEvent(delta=self.prefix))
        await self.gate.wait()
        req.emit(TextEvent(delta="second"))
        self.finished = True
        return AgentResult(status="completed", message=f"{self.prefix}second")


class _ReplayClient:
    def __init__(self, events: list[dict[str, Any]]) -> None:
        self.events = events

    async def send_message(self, request: Any) -> AsyncIterator[StreamResponse]:
        for event in self.events:
            field = (
                "artifact_update"
                if "artifact" in event
                else "status_update"
                if "taskId" in event
                else "task"
            )
            response = StreamResponse()
            ParseDict(event, getattr(response, field))
            yield response


async def test_deltas_arrive_before_completion_and_relay_does_not_duplicate_answer():
    gate = asyncio.Event()
    agent = _GateAgent(gate)
    store = InMemoryTaskStore()
    stream = _stream(_handler(agent, store))
    try:
        events = await _until_delta(stream)
        assert not agent.finished
        assert not gate.is_set()
    finally:
        gate.set()
    events.extend([event async for event in stream])

    chunks = _answer_chunks(events)
    assert [
        (e.get("append", False), e.get("lastChunk", False), e["artifact"].get("parts", []))
        for e in chunks
    ] == [
        (False, False, []),
        (True, False, [{"text": "first ", "mediaType": "text/plain"}]),
        (True, False, [{"text": "second", "mediaType": "text/plain"}]),
        (True, True, []),
    ]
    task_id = events[0]["id"]
    assert {e["artifact"]["artifactId"] for e in chunks} == {f"answer-{task_id}"}
    assert events[-1]["status"]["state"] == "TASK_STATE_COMPLETED"
    saved = await store.get(task_id, ServerCallContext(state={}))
    assert saved is not None
    assert saved.status.message.parts[0].text == "first second"

    deltas: list[str] = []
    result = await execute_remote_a2a(
        _ReplayClient(events),
        RemoteA2aRequest(query="question"),
        on_event=lambda e: deltas.append(e.value) if e.type == "text" else None,
    )
    assert deltas == ["first ", "second"]
    assert result.text == "".join(deltas)
    assert result.state == "completed"


class _FailingAgent:
    async def run(self, req: AgentRequest) -> AgentResult:
        req.emit(TextEvent(delta="partial"))
        raise RuntimeError("provider disconnected")


async def test_partial_answer_closes_before_failure_without_retry():
    events = [event async for event in _stream(_handler(_FailingAgent(), InMemoryTaskStore()))]
    chunks = _answer_chunks(events)
    assert len(chunks) == 3
    assert chunks[-1]["append"] and chunks[-1]["lastChunk"]
    assert not chunks[-1]["artifact"].get("parts")
    assert events[-2] == chunks[-1]
    assert events[-1]["status"]["state"] == "TASK_STATE_FAILED"
    assert "provider disconnected" in events[-1]["status"]["message"]["parts"][0]["text"]


class _ProgressAgent:
    async def run(self, req: AgentRequest) -> AgentResult:
        req.emit(NodeEvent(node="work"))
        req.emit(ReasoningEvent(delta="checking"))
        req.emit(TextEvent(delta=""))
        req.emit(ToolEvent(phase="start", name="lookup"))
        req.emit(A2uiEvent(component=A2uiComponent(component="SimpleTable")))
        return AgentResult(status="completed", message="final")


async def test_non_text_agents_keep_progress_without_empty_answer_artifact():
    events = [event async for event in _stream(_handler(_ProgressAgent(), InMemoryTaskStore()))]
    assert not _answer_chunks(events)
    assert [event["metadata"] for event in events if "metadata" in event] == [
        {"ai37/node": "work"},
        {"ai37/reasoning": "checking"},
    ]
    assert events[-1]["status"]["message"]["parts"][0]["text"] == "final"


async def test_concurrent_executions_have_independent_live_answers():
    gate = asyncio.Event()
    store = InMemoryTaskStore()
    agents = [_GateAgent(gate, prefix) for prefix in ("one ", "two ")]
    streams = [_stream(_handler(agent, store)) for agent in agents]
    try:
        events = await asyncio.gather(*(_until_delta(stream) for stream in streams))
        assert all(not agent.finished for agent in agents)
        assert events[0][0]["id"] != events[1][0]["id"]
    finally:
        gate.set()
    for stream, collected, agent in zip(streams, events, agents, strict=True):
        collected.extend([event async for event in stream])
        chunks = _answer_chunks(collected)
        text = "".join(
            part["text"] for chunk in chunks for part in chunk["artifact"].get("parts", [])
        )
        assert text == f"{agent.prefix}second"
        assert {e["artifact"]["artifactId"] for e in chunks} == {f"answer-{collected[0]['id']}"}
