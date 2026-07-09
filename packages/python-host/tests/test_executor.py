from types import SimpleNamespace
from typing import Any

from a2a.types import Message
from google.protobuf.json_format import MessageToDict, ParseDict

from ai37_agent_host.a2a_executor import HostExecutor
from ai37_agent_host.types import A2uiComponent, AgentRequest, AgentResult, NodeEvent


class FakeEventQueue:
    def __init__(self) -> None:
        self.events: list[Any] = []

    async def enqueue_event(self, event: Any) -> None:
        self.events.append(event)


def _payload(caps: list[str] | None = None) -> dict:
    payload: dict = {"role": "ROLE_USER", "parts": [{"text": "hi"}]}
    if caps is not None:
        payload["metadata"] = {"a2uiClientCapabilities": {"v0.9": {"supportedCatalogIds": caps}}}
    return payload


async def _run(handler: Any, caps: list[str] | None = None, catalog: Any = None) -> list[Any]:
    queue = FakeEventQueue()
    executor = HostExecutor(
        handler, agent_text_modes=["text/markdown", "text/plain"], agent_catalog_ids=catalog
    )
    rc = SimpleNamespace(
        message=ParseDict(_payload(caps), Message(), ignore_unknown_fields=True),
        task_id="t1",
        context_id="c1",
        configuration=None,
        current_task=None,
    )
    await executor.execute(rc, queue)
    return queue.events


def _summarize(events: list[Any]) -> tuple[list[tuple], list[dict]]:
    states: list[tuple] = []
    artifacts: list[dict] = []
    for event in events:
        data = MessageToDict(event, preserving_proto_field_name=False)
        if "status" in data:
            states.append(
                (data["status"]["state"], data.get("metadata"), data["status"].get("message"))
            )
        if "artifact" in data:
            artifacts.append(data["artifact"])
    return states, artifacts


class _Completed:
    async def run(self, req: AgentRequest) -> AgentResult:
        req.emit(NodeEvent(node="step1"))
        return AgentResult(
            status="completed",
            message="done",
            result={"ok": True},
            a2ui=[A2uiComponent(component="SimpleTable", props={"title": "T"})],
        )


class _Failed:
    async def run(self, req: AgentRequest) -> AgentResult:
        return AgentResult(status="failed", message="boom")


class _Raises:
    async def run(self, req: AgentRequest) -> AgentResult:
        raise RuntimeError("kaboom")


class _Hitl:
    async def run(self, req: AgentRequest) -> AgentResult:
        return AgentResult(
            status="input-required",
            message="type?",
            followup=A2uiComponent(component="ChoiceCard", props={"choices": []}),
        )


async def test_completed_flow_with_a2ui_when_catalog_negotiated():
    events = await _run(_Completed(), caps=["cat"], catalog=["cat"])
    states, artifacts = _summarize(events)
    names = [s[0] for s in states]
    assert names[0] == "TASK_STATE_SUBMITTED"
    assert names[-1] == "TASK_STATE_COMPLETED"
    assert any(md and md.get("ai37/node") == "step1" for _, md, _ in states)
    assert len(artifacts) == 1
    data = artifacts[0]["parts"][0]["data"]
    assert data["result"] == {"ok": True}
    assert data["a2ui"] == [{"component": "SimpleTable", "props": {"title": "T"}}]
    assert states[-1][2]["parts"][0]["text"] == "done"


async def test_a2ui_filtered_when_no_catalog():
    events = await _run(_Completed(), caps=None, catalog=["cat"])
    _, artifacts = _summarize(events)
    assert artifacts[0]["parts"][0]["data"]["a2ui"] == []


async def test_failed_flow():
    events = await _run(_Failed())
    states, _ = _summarize(events)
    assert states[-1][0] == "TASK_STATE_FAILED"
    assert states[-1][2]["parts"][0]["text"] == "boom"


async def test_handler_exception_folded_to_failed():
    events = await _run(_Raises())
    states, _ = _summarize(events)
    assert states[-1][0] == "TASK_STATE_FAILED"
    assert "INTERNAL:" in states[-1][2]["parts"][0]["text"]


async def test_input_required_with_followup():
    events = await _run(_Hitl(), caps=["cat"], catalog=["cat"])
    states, artifacts = _summarize(events)
    assert states[-1][0] == "TASK_STATE_INPUT_REQUIRED"
    assert artifacts[0]["parts"][0]["data"]["a2ui"][0]["component"] == "ChoiceCard"
