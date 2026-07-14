"""Тесты MCP challenge-guard: 401+WWW-Authenticate при required, pass-through, ALS-scope."""

from __future__ import annotations

from typing import Any

from ai37_agent_sdk import AgentContextSettings, AuthSettings, BillingSettings

from ai37_agent_host.mcp.challenge_guard import McpChallengeGuardMiddleware

RESOURCE_META = "https://h/.well-known/oauth-protected-resource/mcp"


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


class _StubVerifier:
    def verify(self, token: str) -> dict[str, Any]:
        return {"sub": "u", "org_id": "u", "billing_org_id": "org1"}


def _scope(path: str, *, auth: bytes | None = None) -> dict[str, Any]:
    headers = [(b"authorization", auth)] if auth else []
    return {"type": "http", "path": path, "headers": headers}


async def _run(mw: McpChallengeGuardMiddleware, scope: dict[str, Any]) -> list[dict[str, Any]]:
    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b""}

    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await mw(scope, receive, send)
    return sent


async def test_401_challenge_when_required_and_no_token():
    async def inner(scope: Any, receive: Any, send: Any) -> None:  # noqa: ARG001
        raise AssertionError("downstream must not be called on 401")

    mw = McpChallengeGuardMiddleware(
        inner,
        settings=_settings(True),
        required=True,
        resource_metadata_url=RESOURCE_META,
        guarded_prefixes=["/mcp"],
    )
    sent = await _run(mw, _scope("/mcp"))
    start = sent[0]
    assert start["status"] == 401
    headers = {k.decode(): v.decode() for k, v in start["headers"]}
    assert headers["content-type"] == "application/json"
    assert f'resource_metadata="{RESOURCE_META}"' in headers["www-authenticate"]
    assert 'error="invalid_token"' in headers["www-authenticate"]

    import json

    body = json.loads(sent[1]["body"])
    assert body["jsonrpc"] == "2.0"
    assert body["id"] is None
    assert body["error"]["code"] == -32001


async def test_valid_token_opens_als_scope_and_calls_downstream():
    captured: dict[str, Any] = {}

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        from ai37_agent_host import current_bearer, current_ctx

        captured["bearer"] = current_bearer()
        ctx = current_ctx()
        captured["billing_org"] = ctx.billing_org_id if ctx else None
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = McpChallengeGuardMiddleware(
        inner,
        settings=_settings(True),
        required=True,
        resource_metadata_url=RESOURCE_META,
        guarded_prefixes=["/mcp"],
        overrides={"verifier": _StubVerifier()},
    )
    sent = await _run(mw, _scope("/mcp", auth=b"Bearer a.b.c"))
    assert captured["bearer"] == "a.b.c"
    assert captured["billing_org"] == "org1"
    assert sent[0]["status"] == 200


async def test_not_required_passes_without_ctx():
    captured: dict[str, Any] = {}

    async def inner(scope: Any, receive: Any, send: Any) -> None:
        from ai37_agent_host import current_ctx

        captured["ctx"] = current_ctx()
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    mw = McpChallengeGuardMiddleware(
        inner,
        settings=_settings(False),
        required=False,
        resource_metadata_url=RESOURCE_META,
        guarded_prefixes=["/mcp"],
    )
    sent = await _run(mw, _scope("/mcp"))  # без токена, required=false
    # required=false + нет токена → from_request не бросает; ctx есть, но без claims (анонимно).
    ctx = captured["ctx"]
    assert ctx is not None
    assert ctx.claims is None
    assert sent[0]["status"] == 204


async def test_unguarded_path_passes_through_without_challenge():
    called: dict[str, bool] = {"inner": False}

    async def inner(scope: Any, receive: Any, send: Any) -> None:  # noqa: ARG001
        called["inner"] = True
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    mw = McpChallengeGuardMiddleware(
        inner,
        settings=_settings(True),
        required=True,
        resource_metadata_url=RESOURCE_META,
        guarded_prefixes=["/mcp"],
    )
    # публичный protected-resource-metadata путь — НЕ под /mcp → проходит без 401
    sent = await _run(mw, _scope("/.well-known/oauth-protected-resource/mcp"))
    assert called["inner"] is True
    assert sent[0]["status"] == 200
