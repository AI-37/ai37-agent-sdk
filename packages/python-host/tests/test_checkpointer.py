"""Шов host-checkpointer (порт ts-host): create_agent_host(checkpointer=...) → turn-scope →
current_checkpointer(). Saver типизирован Any (host не тянет langgraph) — здесь sentinel."""

from typing import Any

from ai37_agent_sdk import AgentContextSettings, AuthSettings, BillingSettings
from fastapi.testclient import TestClient

from ai37_agent_host import current_checkpointer
from ai37_agent_host.auth_guard import AuthGuardMiddleware
from ai37_agent_host.create_agent_host import create_agent_host
from ai37_agent_host.types import AgentRequest, AgentResult

CARD = {
    "name": "CP Test Agent",
    "description": "d",
    "version": "0.0.0",
    "url": "http://localhost/a2a/v1",
    "defaultInputModes": ["application/json"],
    "defaultOutputModes": ["text/markdown", "text/plain"],
    "capabilities": {"streaming": True},
    "skills": [{"id": "s", "name": "S", "description": "d"}],
}


def _settings(required: bool) -> AgentContextSettings:
    return AgentContextSettings(
        auth=AuthSettings(
            issuer="https://iss/",
            audience="aud",
            jwks_url="https://iss/jwks",
            required=required,
        ),
        billing=BillingSettings(base_url="http://billing", apps_auth_token="apps"),
    )


def test_current_checkpointer_none_outside_scope() -> None:
    # Вне turn-scope (нет активного request'а) → None: агент строит граф без durable-состояния.
    assert current_checkpointer() is None


async def test_checkpointer_propagates_through_guard() -> None:
    sentinel = object()  # saver-заглушка (Any); проверяем идентичность через ALS-границу.
    captured: dict[str, Any] = {}

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        captured["cp"] = current_checkpointer()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = AuthGuardMiddleware(
        inner,
        settings=_settings(False),
        required=False,
        guarded_prefixes=["/a2a/v1"],
        checkpointer=sentinel,
    )
    scope = {"type": "http", "path": "/a2a/v1", "headers": []}

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b""}

    async def send(message: dict[str, Any]) -> None:
        pass

    await mw(scope, receive, send)
    # checkpointer, выставленный host'ом, доехал до downstream через contextvars.
    assert captured["cp"] is sentinel


def test_create_agent_host_injects_checkpointer_into_scope() -> None:
    sentinel = object()
    captured: dict[str, Any] = {}

    class ProbeHandler:
        async def run(self, req: AgentRequest) -> AgentResult:
            captured["cp"] = current_checkpointer()
            return AgentResult(status="completed", message="ok")

    app = create_agent_host(
        card=CARD,
        handler=ProbeHandler(),
        agent_context=_settings(False),
        checkpointer=sentinel,
    )
    client = TestClient(app)
    resp = client.post(
        "/a2a/v1",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "message/send",
            "params": {
                "message": {
                    "kind": "message",
                    "messageId": "m1",
                    "role": "user",
                    "parts": [{"kind": "text", "text": "hi"}],
                }
            },
        },
    )
    assert resp.status_code != 401
    assert captured["cp"] is sentinel


def test_create_agent_host_without_checkpointer_is_none() -> None:
    captured: dict[str, Any] = {}

    class ProbeHandler:
        async def run(self, req: AgentRequest) -> AgentResult:
            captured["cp"] = current_checkpointer()
            return AgentResult(status="completed", message="ok")

    app = create_agent_host(card=CARD, handler=ProbeHandler(), agent_context=_settings(False))
    client = TestClient(app)
    client.post(
        "/a2a/v1",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "message/send",
            "params": {
                "message": {
                    "kind": "message",
                    "messageId": "m1",
                    "role": "user",
                    "parts": [{"kind": "text", "text": "hi"}],
                }
            },
        },
    )
    assert captured["cp"] is None
