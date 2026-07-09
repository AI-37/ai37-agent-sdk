from typing import Any

from ai37_agent_sdk import AgentContextSettings, AuthSettings, BillingSettings
from fastapi.testclient import TestClient

from ai37_agent_host.auth_guard import AuthGuardMiddleware
from ai37_agent_host.create_agent_host import create_agent_host
from ai37_agent_host.types import AgentRequest, AgentResult

CARD = {
    "name": "Test Agent",
    "description": "d",
    "version": "0.0.0",
    "url": "http://localhost/a2a/v1",
    "defaultInputModes": ["application/json"],
    "defaultOutputModes": ["text/markdown", "text/plain"],
    "capabilities": {"streaming": True},
    "skills": [{"id": "s", "name": "S", "description": "d"}],
    "x-ai37": {
        "billing": {
            "metered": True,
            "feature": "minstroy-agent",
            "privilege": "minstroy-check-inn",
        },
    },
}


class OkHandler:
    async def run(self, req: AgentRequest) -> AgentResult:
        return AgentResult(status="completed", message="ok")


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


def test_health_and_agent_card():
    app = create_agent_host(card=CARD, handler=OkHandler(), agent_context=_settings(False))
    client = TestClient(app)
    assert client.get("/api/v1/health").json()["status"] == "ok"
    body = client.get("/.well-known/agent-card.json").json()
    assert body["name"] == "Test Agent"
    assert body["defaultOutputModes"] == ["text/markdown", "text/plain"]
    # x-ai37-расширение переживает protobuf-нормализацию (нужно orchestrator-фильтру Ф9).
    assert body["x-ai37"]["billing"]["feature"] == "minstroy-agent"
    assert body["x-ai37"]["billing"]["privilege"] == "minstroy-check-inn"


def test_guard_401_when_required_and_no_token():
    app = create_agent_host(card=CARD, handler=OkHandler(), agent_context=_settings(True))
    client = TestClient(app)
    resp = client.post(
        "/a2a/v1", json={"jsonrpc": "2.0", "id": 1, "method": "message/send", "params": {}}
    )
    assert resp.status_code == 401
    assert resp.json()["error"] == "unauthorized"


def test_guard_passes_when_not_required():
    app = create_agent_host(card=CARD, handler=OkHandler(), agent_context=_settings(False))
    client = TestClient(app)
    resp = client.post(
        "/a2a/v1", json={"jsonrpc": "2.0", "id": 1, "method": "message/send", "params": {}}
    )
    assert resp.status_code != 401


class _StubVerifier:
    def verify(self, token: str) -> dict[str, Any]:
        return {"sub": "u", "org_id": "u", "billing_org_id": "org1"}


async def test_als_scope_propagates_through_pure_asgi_middleware():
    captured: dict[str, Any] = {}

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        from ai37_agent_host import current_bearer, current_ctx

        captured["bearer"] = current_bearer()
        ctx = current_ctx()
        captured["billing_org"] = ctx.billing_org_id if ctx else None
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = AuthGuardMiddleware(
        inner,
        settings=_settings(True),
        required=True,
        guarded_prefixes=["/a2a/v1"],
        overrides={"verifier": _StubVerifier()},
    )
    scope = {"type": "http", "path": "/a2a/v1", "headers": [(b"authorization", b"Bearer a.b.c")]}

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b""}

    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await mw(scope, receive, send)
    # ALS-scope, выставленный в middleware, виден downstream (contextvars доехали)
    assert captured["bearer"] == "a.b.c"
    assert captured["billing_org"] == "org1"
    assert sent[0]["status"] == 200
