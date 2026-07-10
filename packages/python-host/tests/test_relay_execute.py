"""Тесты execute_remote_a2a: разбор ответа суб-агента + форвард прогресса + stale-resume retry."""

from typing import Any

from google.protobuf.json_format import MessageToDict, ParseDict

from ai37_agent_host.relay import RemoteA2aRequest, execute_remote_a2a
from ai37_agent_host.types import ContextFile


def _sr(payload_field: str, data: dict[str, Any]) -> Any:
    from a2a.types.a2a_pb2 import StreamResponse

    sr = StreamResponse()
    ParseDict(data, getattr(sr, payload_field))
    return sr


def _completed_task_sr() -> Any:
    return _sr(
        "task",
        {
            "id": "task-1",
            "contextId": "ctx1",
            "status": {
                "state": "TASK_STATE_COMPLETED",
                "message": {
                    "role": "ROLE_AGENT",
                    "parts": [{"text": "Готово", "mediaType": "text/plain"}],
                },
            },
            "artifacts": [
                {
                    "artifactId": "a1",
                    "parts": [
                        {
                            "data": {"a2ui": [{"component": "SimpleTable", "props": {}}]},
                            "mediaType": "application/json",
                        }
                    ],
                }
            ],
        },
    )


def _progress_sr() -> Any:
    return _sr(
        "status_update",
        {
            "taskId": "task-1",
            "contextId": "ctx1",
            "status": {"state": "TASK_STATE_WORKING"},
            "metadata": {"ai37/node": "verify"},
        },
    )


class _FakeClient:
    def __init__(self, events: list[Any]) -> None:
        self._events = events
        self.sent: list[Any] = []

    async def send_message(self, request: Any, *, context: Any = None):
        self.sent.append(request)
        for ev in self._events:
            yield ev


class _StaleThenOk:
    def __init__(self, ok_events: list[Any]) -> None:
        self.calls = 0
        self._ok = ok_events
        self.sent: list[Any] = []

    async def send_message(self, request: Any, *, context: Any = None):
        self.sent.append(request)
        self.calls += 1
        if self.calls == 1:
            raise RuntimeError("Task not found")
            yield  # недостижимо — но делает метод async-генератором
        for ev in self._ok:
            yield ev


async def test_completed_with_a2ui_and_progress_and_forward():
    client = _FakeClient([_progress_sr(), _completed_task_sr()])
    seen: list[tuple[str, str]] = []
    req = RemoteA2aRequest(
        query="проверь контрагентов",
        context_id="ctx1",
        context_files=[ContextFile(ref="chat-attachment:1", name="list.xlsx", scope="chat")],
        supported_catalog_ids=["cat-v2"],
    )
    res = await execute_remote_a2a(client, req, on_event=lambda e: seen.append((e.type, e.value)))

    assert res.state == "completed"
    assert res.task_id == "task-1"
    assert "Готово" in res.text
    assert res.a2ui and res.a2ui[0]["component"] == "SimpleTable"
    assert ("node", "verify") in seen
    assert res.stale_resume_dropped is False

    sent = MessageToDict(client.sent[0], preserving_proto_field_name=False)
    meta = sent["message"]["metadata"]
    assert meta["ai37"]["context_files"][0]["ref"] == "chat-attachment:1"
    assert meta["a2uiClientCapabilities"]["v0.9"]["supportedCatalogIds"] == ["cat-v2"]


def _tool_progress_sr() -> Any:
    return _sr(
        "status_update",
        {
            "taskId": "task-1",
            "contextId": "ctx1",
            "status": {"state": "TASK_STATE_WORKING"},
            "metadata": {
                "ai37/tool": {
                    "id": "tc1",
                    "name": "Поиск ЕГРЮЛ",
                    "toolName": "egrul",
                    "args": {"inn": "7707083893"},
                }
            },
        },
    )


def _append_text_sr(text: str, *, append: bool) -> Any:
    data: dict[str, Any] = {
        "taskId": "task-1",
        "contextId": "ctx1",
        "artifact": {"artifactId": "a1", "parts": [{"text": text, "mediaType": "text/plain"}]},
    }
    if append:
        data["append"] = True
    return _sr("artifact_update", data)


async def test_tool_call_forwarded_from_ai37_tool_metadata():
    client = _FakeClient([_tool_progress_sr(), _completed_task_sr()])
    events: list[Any] = []
    res = await execute_remote_a2a(
        client, RemoteA2aRequest(query="x", context_id="ctx1"), on_event=events.append
    )
    assert res.state == "completed"
    tools = [e for e in events if e.type == "tool"]
    assert len(tools) == 1
    tc = tools[0].tool
    assert tc is not None
    assert (tc.id, tc.name, tc.tool_name) == ("tc1", "Поиск ЕГРЮЛ", "egrul")
    assert tc.args == {"inn": "7707083893"}
    assert tools[0].value == ""


async def test_text_streamed_only_on_append():
    # append=true → дельта стримится; снапшот(replace, без append) → НЕ стримится (иначе дубли).
    client = _FakeClient(
        [
            _append_text_sr("Итог: ", append=True),
            _append_text_sr("СНАПШОТ-ЦЕЛИКОМ", append=False),
            _completed_task_sr(),
        ]
    )
    events: list[Any] = []
    await execute_remote_a2a(
        client, RemoteA2aRequest(query="x", context_id="ctx1"), on_event=events.append
    )
    texts = [e.value for e in events if e.type == "text"]
    assert texts == ["Итог: "]


async def test_stale_resume_retries_without_task_id():
    client = _StaleThenOk([_completed_task_sr()])
    req = RemoteA2aRequest(query="продолжай", context_id="ctx1", resume_task_id="old-task")
    res = await execute_remote_a2a(client, req)

    assert res.state == "completed"
    assert res.stale_resume_dropped is True
    assert client.calls == 2
    # первый вызов нёс taskId (resume), повтор — без него.
    first = MessageToDict(client.sent[0], preserving_proto_field_name=False)["message"]
    second = MessageToDict(client.sent[1], preserving_proto_field_name=False)["message"]
    assert first.get("taskId") == "old-task"
    assert "taskId" not in second
