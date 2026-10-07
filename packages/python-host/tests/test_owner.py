"""Владелец задачи из JWT хода: ``owner.py`` и его проводка в ``create_agent_host``."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from ai37_agent_sdk import AgentContextSettings, AuthSettings, BillingSettings
from fastapi.testclient import TestClient
from starlette.requests import Request

from ai37_agent_host.als import HostScope, scope_context
from ai37_agent_host.auth_guard import AuthGuardMiddleware
from ai37_agent_host.create_agent_host import create_agent_host
from ai37_agent_host.owner import (
    HostCallContextBuilder,
    JwtUser,
    current_call_context,
    current_user,
)
from ai37_agent_host.types import AgentRequest, AgentResult


def _scope(claims: dict[str, Any] | None) -> Any:
    return scope_context(HostScope(ctx=SimpleNamespace(claims=claims)))


def _request() -> Request:
    return Request({"type": "http", "headers": [], "path": "/a2a/v1"})


def test_user_from_jwt_claims() -> None:
    with _scope({"sub": "alice", "org_id": "org-7"}):
        user = current_user()
    assert isinstance(user, JwtUser)
    assert user.is_authenticated
    assert user.user_name == "org-7:alice"


def test_no_scope_is_anonymous() -> None:
    user = current_user()
    assert not user.is_authenticated
    assert user.user_name == ""


@pytest.mark.parametrize("claims", [None, {}, {"org_id": "org-1"}])
def test_claims_without_sub_are_anonymous(claims: dict[str, Any] | None) -> None:
    with _scope(claims):
        assert not current_user().is_authenticated


def test_call_context_carries_user() -> None:
    with _scope({"sub": "bob", "org_id": "o"}):
        assert current_call_context().user.user_name == "o:bob"


def test_builder_uses_jwt_user_inside_turn() -> None:
    builder = HostCallContextBuilder()
    with _scope({"sub": "alice", "org_id": "org-1"}):
        assert builder.build(_request()).user.user_name == "org-1:alice"


def test_builder_outside_turn_falls_back_to_upstream() -> None:
    context = HostCallContextBuilder().build(_request())
    assert not context.user.is_authenticated


# ── сквозной путь A2A: задача видна только своему владельцу ───────────────────


class _PauseHandler:
    async def run(self, req: AgentRequest) -> AgentResult:
        return AgentResult(status="input-required", message="нужны данные")


CARD = {
    "name": "Owner Agent",
    "description": "d",
    "version": "0.0.0",
    "url": "http://localhost/a2a/v1",
    "defaultInputModes": ["application/json"],
    "defaultOutputModes": ["text/plain"],
    "capabilities": {"streaming": True},
    "skills": [{"id": "s", "name": "S", "description": "d"}],
}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    def fake_ctx(self: AuthGuardMiddleware, headers: dict[str, str]) -> Any:
        sub = headers.get("authorization", "").removeprefix("Bearer ")
        return SimpleNamespace(claims={"sub": sub, "org_id": "org-1"}, billing_org_id="org-1")

    monkeypatch.setattr(AuthGuardMiddleware, "_build_ctx", fake_ctx)
    settings = AgentContextSettings(
        auth=AuthSettings(issuer="https://iss/", audience="aud", jwks_url="https://iss/jwks"),
        billing=BillingSettings(base_url="http://billing", apps_auth_token="apps"),
    )
    app = create_agent_host(card=CARD, handler=_PauseHandler(), agent_context=settings)
    return TestClient(app)


def _rpc(client: TestClient, user: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
    resp = client.post(
        "/a2a/v1",
        headers={"Authorization": f"Bearer {user}"},
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
    )
    assert resp.status_code == 200
    return resp.json()


def test_paused_task_is_visible_only_to_its_owner(client: TestClient) -> None:
    sent = _rpc(
        client,
        "alice",
        "message/send",
        {
            "message": {
                "kind": "message",
                "messageId": "m1",
                "role": "user",
                "parts": [{"kind": "text", "text": "hi"}],
            }
        },
    )
    task_id = sent["result"]["id"]
    assert sent["result"]["status"]["state"] == "input-required"

    own = _rpc(client, "alice", "tasks/get", {"id": task_id})
    assert own["result"]["id"] == task_id

    foreign = _rpc(client, "bob", "tasks/get", {"id": task_id})
    assert "error" in foreign
