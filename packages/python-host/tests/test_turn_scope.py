"""Ход в существующую задачу видит СВОЙ запрос, а не тот, что задачу создал.

a2a-sdk держит на незавершённую задачу один долгоживущий producer (``ActiveTask._run_producer``):
его создаёт ``asyncio.create_task`` на первом запросе, и он копирует contextvars ТОГО запроса.
Следующие ходы приходят в producer через очередь, а ALS-scope остаётся первым. Прод 02.11:
пользователь вернулся в диалог через три дня, guard проверил свежий JWT, а в billing ``/state``
ушёл JWT трёхдневной давности → ``401 invalid bearer token`` и «агент временно недоступен».
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from ai37_agent_sdk import AgentContextSettings, AuthSettings, BillingSettings
from fastapi.testclient import TestClient

from ai37_agent_host.als import current_bearer, current_ctx, current_turn_context
from ai37_agent_host.auth_guard import AuthGuardMiddleware
from ai37_agent_host.create_agent_host import create_agent_host
from ai37_agent_host.types import AgentRequest, AgentResult

CARD = {
    "name": "Turn Scope Agent",
    "description": "d",
    "version": "0.0.0",
    "url": "http://localhost/a2a/v1",
    "defaultInputModes": ["application/json"],
    "defaultOutputModes": ["text/plain"],
    "capabilities": {"streaming": True},
    "skills": [{"id": "s", "name": "S", "description": "d"}],
}


class _RecordingHandler:
    """Каждый ход — input-required (задача не терминальна), запоминает, что видит."""

    def __init__(self) -> None:
        self.seen: list[dict[str, Any]] = []

    async def run(self, req: AgentRequest) -> AgentResult:
        turn = current_turn_context()
        self.seen.append(
            {
                "req_token": getattr(req.ctx, "raw_token", None),
                "als_token": getattr(current_ctx(), "raw_token", None),
                "bearer": current_bearer(),
                "turn_task": turn.task_id if turn else None,
            }
        )
        return AgentResult(status="input-required", message="ещё")


@pytest.fixture
def handler() -> _RecordingHandler:
    return _RecordingHandler()


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, handler: _RecordingHandler) -> Any:
    def fake_ctx(self: AuthGuardMiddleware, headers: dict[str, str]) -> Any:
        token = headers.get("authorization", "").removeprefix("Bearer ")
        # Один пользователь, разные токены: владелец задачи тот же, меняется только JWT.
        return SimpleNamespace(
            claims={"sub": "alice", "org_id": "org-1"}, billing_org_id="org-1", raw_token=token
        )

    monkeypatch.setattr(AuthGuardMiddleware, "_build_ctx", fake_ctx)
    settings = AgentContextSettings(
        auth=AuthSettings(issuer="https://iss/", audience="aud", jwks_url="https://iss/jwks"),
        billing=BillingSettings(base_url="http://billing", apps_auth_token="apps"),
    )
    app = create_agent_host(card=CARD, handler=handler, agent_context=settings)
    # `with` — один event loop на все запросы, как в живом процессе: только так producer первого
    # хода доживает до второго.
    with TestClient(app) as test_client:
        yield test_client


def _send(client: TestClient, token: str, task_id: str | None = None) -> dict[str, Any]:
    message: dict[str, Any] = {
        "kind": "message",
        "messageId": f"m-{token}",
        "role": "user",
        "parts": [{"kind": "text", "text": "hi"}],
    }
    if task_id:
        message["taskId"] = task_id
    resp = client.post(
        "/a2a/v1",
        headers={"Authorization": f"Bearer {token}"},
        json={"jsonrpc": "2.0", "id": 1, "method": "message/send", "params": {"message": message}},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "result" in body, body
    return body["result"]


def test_resumed_turn_sees_its_own_request_scope(
    client: TestClient, handler: _RecordingHandler
) -> None:
    first = _send(client, "token-30-10")
    assert first["status"]["state"] == "input-required"

    second = _send(client, "token-02-11", task_id=first["id"])
    assert second["id"] == first["id"], "второй ход должен попасть в ту же задачу"

    assert [turn["req_token"] for turn in handler.seen] == ["token-30-10", "token-02-11"]
    assert [turn["als_token"] for turn in handler.seen] == ["token-30-10", "token-02-11"]
    assert [turn["bearer"] for turn in handler.seen] == ["token-30-10", "token-02-11"]
    assert [turn["turn_task"] for turn in handler.seen] == [first["id"], first["id"]]
