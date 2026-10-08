"""Guard'ы fail-closed (паритет с ts-host ``test/auth-guard.test.ts``).

При ``required`` любой сбой проверки завершает запрос: ``AuthError`` → 401, остальное → 503,
downstream не вызывается. При ``required=False`` — аноним, как раньше.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import pytest
from ai37_agent_sdk import (
    AgentContextSettings,
    AuthError,
    AuthSettings,
    BillingConfigurationError,
    BillingSettings,
)
from prometheus_client import REGISTRY

from ai37_agent_host.auth_guard import AuthGuardMiddleware
from ai37_agent_host.mcp.challenge_guard import McpChallengeGuardMiddleware

RESOURCE_META = "https://h/.well-known/oauth-protected-resource/mcp"
CLAIMS = {"sub": "alice", "org_id": "org-1", "billing_org_id": "b-org-1"}


def _settings(required: bool, *, apps_token: str | None = None) -> AgentContextSettings:
    """Без ``apps_auth_token`` ``from_request`` бросит ``BillingConfigurationError``."""
    return AgentContextSettings(
        auth=AuthSettings(
            issuer="https://iss/", audience="aud", jwks_url="https://iss/jwks", required=required
        ),
        billing=BillingSettings(base_url="http://billing", apps_auth_token=apps_token),
    )


class _StubVerifier:
    def verify(self, token: str) -> dict[str, Any]:  # noqa: ARG002
        return CLAIMS


class _RaisingVerifier:
    def __init__(self, exc: BaseException) -> None:
        self._exc = exc

    def verify(self, token: str) -> dict[str, Any]:  # noqa: ARG002
        raise self._exc


def _guard(
    kind: str, required: bool, verifier: Any | None, service: str, *, apps_token: str | None = None
) -> tuple[Any, list[str | None]]:
    calls: list[str | None] = []

    async def inner(scope: Any, receive: Any, send: Any) -> None:  # noqa: ARG001
        from ai37_agent_host import current_ctx

        ctx = current_ctx()
        calls.append(ctx.claims.get("sub") if ctx and ctx.claims else None)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    overrides = {"verifier": verifier} if verifier is not None else {}
    settings = _settings(required, apps_token=apps_token)
    if kind == "jwt":
        mw: Any = AuthGuardMiddleware(
            inner,
            settings=settings,
            required=required,
            guarded_prefixes=["/a2a/v1"],
            overrides=overrides,
            service=service,
        )
    else:
        mw = McpChallengeGuardMiddleware(
            inner,
            settings=settings,
            required=required,
            resource_metadata_url=RESOURCE_META,
            guarded_prefixes=["/a2a/v1"],
            overrides=overrides,
            service=service,
        )
    return mw, calls


async def _call(mw: Any, bearer: str | None = None) -> tuple[int, dict[str, str], Any]:
    headers = [(b"authorization", f"Bearer {bearer}".encode())] if bearer else []
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b""}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await mw({"type": "http", "path": "/a2a/v1", "headers": headers}, receive, send)
    start = sent[0]
    resp_headers = {k.decode(): v.decode() for k, v in start.get("headers", [])}
    body = sent[1]["body"]
    return start["status"], resp_headers, json.loads(body) if body != b"ok" else body


def _metric(name: str, service: str) -> float:
    return REGISTRY.get_sample_value(name, {"service": service}) or 0.0


# --- AuthGuardMiddleware, required=True -----------------------------------------------------


async def test_required_no_token_401() -> None:
    mw, calls = _guard("jwt", True, None, "py-401-missing")
    status, _, body = await _call(mw)
    assert status == 401
    assert body["error"] == "unauthorized"
    assert calls == []


async def test_required_auth_error_401_and_metric() -> None:
    mw, calls = _guard("jwt", True, _RaisingVerifier(AuthError("bad")), "py-401-invalid")
    status, _, _ = await _call(mw, "tok")
    assert status == 401
    assert calls == []
    assert _metric("ai37_agent_auth_failures_total", "py-401-invalid") == 1.0


async def test_required_billing_config_error_503(caplog: pytest.LogCaptureFixture) -> None:
    mw, calls = _guard("jwt", True, _StubVerifier(), "py-503-billing")
    with caplog.at_level(logging.ERROR, logger="ai37_agent_host.auth_guard"):
        status, _, body = await _call(mw, "opaque-api-key")
    assert status == 503
    assert body == {"error": "auth_unavailable"}
    assert calls == []
    assert "BillingConfigurationError" in caplog.text
    assert _metric("ai37_agent_auth_guard_errors_total", "py-503-billing") == 1.0


@pytest.mark.parametrize(
    "exc",
    [
        ConnectionError("JWKS fetch failed"),
        BillingConfigurationError("boom"),
        RuntimeError("unexpected"),
    ],
    ids=["jwks-outside-autherror", "billing-config-from-verifier", "generic"],
)
async def test_required_non_auth_error_503(exc: BaseException) -> None:
    mw, calls = _guard("jwt", True, _RaisingVerifier(exc), "py-503-generic")
    status, _, _ = await _call(mw, "tok")
    assert status == 503
    assert calls == []


async def test_required_valid_ctx_passes() -> None:
    mw, calls = _guard("jwt", True, _StubVerifier(), "py-ok", apps_token="apps")
    status, _, _ = await _call(mw, "tok")
    assert status == 200
    assert calls == ["alice"]


async def test_log_redacts_secrets(caplog: pytest.LogCaptureFixture) -> None:
    secret = "sk-live-opaque-key-123"
    jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJl"
    leaky = RuntimeError(f"introspection of {secret} failed; Bearer other-token; {jwt}")
    mw, _ = _guard("jwt", True, _RaisingVerifier(leaky), "py-503-redact")
    with caplog.at_level(logging.ERROR, logger="ai37_agent_host.auth_guard"):
        await _call(mw, secret)
    assert "introspection of [redacted] failed" in caplog.text
    assert secret not in caplog.text
    assert "other-token" not in caplog.text
    assert jwt not in caplog.text


async def test_log_truncates_long_message(caplog: pytest.LogCaptureFixture) -> None:
    mw, _ = _guard("jwt", True, _RaisingVerifier(RuntimeError("x" * 5000)), "py-503-long")
    with caplog.at_level(logging.ERROR, logger="ai37_agent_host.auth_guard"):
        await _call(mw, "tok")
    assert len(caplog.records[0].getMessage()) < 500


# --- AuthGuardMiddleware, required=False ----------------------------------------------------


@pytest.mark.parametrize(
    ("verifier", "bearer"),
    [
        (_StubVerifier(), "opaque"),  # BillingConfigurationError
        (_RaisingVerifier(AuthError("bad")), "tok"),
        (_RaisingVerifier(RuntimeError("x")), "tok"),
        (None, None),
    ],
    ids=["billing-config", "auth-error", "generic", "no-token"],
)
async def test_optional_passes_anonymous(verifier: Any, bearer: str | None) -> None:
    mw, calls = _guard("jwt", False, verifier, "py-optional")
    status, _, _ = await _call(mw, bearer)
    assert status == 200
    assert calls == [None]


# --- McpChallengeGuardMiddleware ------------------------------------------------------------


async def test_mcp_required_auth_error_401_challenge() -> None:
    mw, calls = _guard("mcp", True, None, "py-m-401")
    status, headers, _ = await _call(mw)
    assert status == 401
    assert "resource_metadata=" in headers["www-authenticate"]
    assert calls == []


async def test_mcp_required_billing_config_error_503_no_challenge() -> None:
    mw, calls = _guard("mcp", True, _StubVerifier(), "py-m-503")
    status, headers, body = await _call(mw, "opaque-api-key")
    assert status == 503
    assert "www-authenticate" not in headers
    assert body == {
        "jsonrpc": "2.0",
        "error": {"code": -32603, "message": "auth unavailable"},
        "id": None,
    }
    assert calls == []
    assert _metric("ai37_agent_auth_guard_errors_total", "py-m-503") == 1.0


async def test_mcp_optional_failure_passes_anonymous() -> None:
    mw, calls = _guard("mcp", False, _RaisingVerifier(RuntimeError("x")), "py-m-opt")
    status, _, _ = await _call(mw, "tok")
    assert status == 200
    assert calls == [None]
