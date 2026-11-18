"""Локаль хода (план docs#589, срез 3) — паритет с ts-host ``test/locale.test.ts``.

Host кладёт локаль в scope на обоих входах (A2A и AG-UI), когниция читает ``current_locale()`` /
``with_user_locale()``, relay форвардит ``metadata.ai37.locale``, фолбэки статусов хоста — на языке
хода.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from ai37_agent_sdk import AgentContextSettings, AuthSettings, BillingSettings
from fastapi.testclient import TestClient
from google.protobuf.json_format import MessageToDict

from ai37_agent_host import current_locale, with_user_locale
from ai37_agent_host.agui import extract_ai37
from ai37_agent_host.als import HostScope, scope_context
from ai37_agent_host.auth_guard import AuthGuardMiddleware
from ai37_agent_host.create_agent_host import create_agent_host
from ai37_agent_host.host_messages import HOST_MESSAGES
from ai37_agent_host.mcp import BridgeToolOptions, bridge_handler_to_mcp_tool
from ai37_agent_host.parse import _to_ai37_metadata
from ai37_agent_host.relay.execute import RemoteA2aRequest, _build_request
from ai37_agent_host.types import AgentRequest, AgentResult

CARD = {
    "name": "Locale Agent",
    "description": "d",
    "version": "0.0.0",
    "url": "http://localhost/a2a/v1",
    "defaultInputModes": ["application/json"],
    "defaultOutputModes": ["text/plain"],
    "capabilities": {"streaming": True},
    "skills": [{"id": "s", "name": "S", "description": "d"}],
}


def _ctx(claims: dict[str, Any]) -> Any:
    return SimpleNamespace(claims=claims, billing_org_id="org-1", raw_token="t")


# ───────────────────────── current_locale / with_user_locale ─────────────────────────


def test_current_locale_outside_turn_is_ru() -> None:
    assert current_locale() == "ru"


def test_current_locale_scope_wins_over_claims() -> None:
    with scope_context(HostScope(locale="es-MX", ctx=_ctx({"locale": "de"}))):
        assert current_locale() == "es-MX"


def test_current_locale_without_scope_locale_uses_claims() -> None:
    # Путь MCP: host локаль в scope не кладёт, остаются claims токена.
    with scope_context(HostScope(ctx=_ctx({"locale": "de", "org_locale": "fr"}))):
        assert current_locale() == "de"
    with scope_context(HostScope(ctx=_ctx({"org_locale": "fr"}))):
        assert current_locale() == "fr"


def test_with_user_locale_appends_section() -> None:
    base = "Ты ассистент по нормам."
    with scope_context(HostScope(locale="es")):
        out = with_user_locale(base)
    assert out.startswith(f"{base}\n\n## Язык ответа")
    assert "Español (es)" in out
    assert "«[название, пункт]»" in out


def test_with_user_locale_explicit_and_unknown_language() -> None:
    with scope_context(HostScope(locale="es")):
        assert "Français (fr)" in with_user_locale("p", "fr")
    with scope_context(HostScope(locale="pl")):
        assert "«pl»" in with_user_locale("p")


def test_host_messages_cover_every_language() -> None:
    for texts in HOST_MESSAGES.values():
        assert sorted(texts) == ["de", "en", "es", "fr", "pt", "ru"]


# ───────────────────────── мост MCP ─────────────────────────


class _Empty:
    async def run(self, req: AgentRequest) -> AgentResult:
        return AgentResult(status="completed")


async def test_mcp_bridge_status_text_follows_locale() -> None:
    options = BridgeToolOptions(name="t", title="T", description="d")
    tool = bridge_handler_to_mcp_tool(_Empty(), options)
    assert (await tool.handler({"query": "x"}, None)).content[0]["text"] == "Готово"
    with scope_context(HostScope(locale="de")):
        assert (await tool.handler({"query": "x"}, None)).content[0]["text"] == "Fertig"


# ───────────────────────── relay ─────────────────────────


def _sent_ai37(req: RemoteA2aRequest) -> dict[str, Any] | None:
    sent = MessageToDict(_build_request(req, with_resume=False), preserving_proto_field_name=False)
    return sent["message"].get("metadata", {}).get("ai37")


def test_relay_forwards_locale_without_truncation() -> None:
    assert _sent_ai37(RemoteA2aRequest(query="x", locale="ca-ES-valencia")) == {
        "locale": "ca-ES-valencia"
    }


def test_relay_extra_ai37_merges_with_envelope() -> None:
    # Интент скилла через escape hatch не стирает локаль и context_refs хода.
    req = RemoteA2aRequest(
        query="x",
        locale="es",
        context_refs=["chat-attachment:41"],
        extra_metadata={"ai37": {"intent": {"skill": "norm-parameter"}}, "hop": 2},
    )
    assert _sent_ai37(req) == {
        "locale": "es",
        "context_refs": ["chat-attachment:41"],
        "intent": {"skill": "norm-parameter"},
    }


def test_relay_without_locale_keeps_old_envelope() -> None:
    assert _sent_ai37(RemoteA2aRequest(query="x")) is None


# ───────────────────────── входы A2A и AG-UI ─────────────────────────


class _EchoLocale:
    """Отдаёт, что видит когниция: локаль хода и поле конверта."""

    def __init__(self, status: str = "completed") -> None:
        self.status = status
        self.seen: list[tuple[str, str | None]] = []

    async def run(self, req: AgentRequest) -> AgentResult:
        self.seen.append((current_locale(), req.input.metadata.locale))
        if self.status == "completed":
            return AgentResult(status="completed", message=f"locale={current_locale()}")
        return AgentResult(status=self.status)  # type: ignore[arg-type]


def _client(monkeypatch: pytest.MonkeyPatch, handler: Any, claims: dict[str, Any]) -> TestClient:
    monkeypatch.setattr(AuthGuardMiddleware, "_build_ctx", lambda self, headers: _ctx(claims))
    settings = AgentContextSettings(
        auth=AuthSettings(issuer="https://iss/", audience="aud", jwks_url="https://iss/jwks"),
        billing=BillingSettings(base_url="http://billing", apps_auth_token="apps"),
    )
    return TestClient(create_agent_host(card=CARD, handler=handler, agent_context=settings))


def _a2a(client: TestClient, ai37: dict[str, Any] | None) -> dict[str, Any]:
    message: dict[str, Any] = {
        "kind": "message",
        "messageId": "m-1",
        "role": "user",
        "parts": [{"kind": "text", "text": "hi"}],
    }
    if ai37 is not None:
        message["metadata"] = {"ai37": ai37}
    resp = client.post(
        "/a2a/v1",
        headers={"Authorization": "Bearer t"},
        json={"jsonrpc": "2.0", "id": 1, "method": "message/send", "params": {"message": message}},
    )
    assert resp.status_code == 200
    return resp.json()["result"]


def test_a2a_envelope_locale_reaches_handler_without_truncation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    handler = _EchoLocale()
    with _client(monkeypatch, handler, {"locale": "de"}) as client:
        _a2a(client, {"locale": "es-mx"})
    # §10: тег с регионом без обрезки; конверт важнее claim.
    assert handler.seen == [("es-MX", "es-mx")]


def test_a2a_without_envelope_locale_uses_claims_then_ru(monkeypatch: pytest.MonkeyPatch) -> None:
    handler = _EchoLocale()
    with _client(monkeypatch, handler, {"org_locale": "fr"}) as client:
        _a2a(client, None)
    assert handler.seen == [("fr", None)]


def test_a2a_unknown_language_and_status_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    # §10: язык вне словаря (pl) не отвергается, детерминированные строки хоста — на en.
    handler = _EchoLocale(status="input-required")
    with _client(monkeypatch, handler, {}) as client:
        result = _a2a(client, {"locale": "pl"})
    assert handler.seen == [("pl", "pl")]
    assert result["status"]["message"]["parts"][0]["text"] == "Please clarify"


def test_a2a_status_fallback_without_locale_is_russian(monkeypatch: pytest.MonkeyPatch) -> None:
    handler = _EchoLocale(status="failed")
    with _client(monkeypatch, handler, {}) as client:
        result = _a2a(client, None)
    assert result["status"]["message"]["parts"][0]["text"] == "Ошибка"


def test_agui_extract_ai37_keeps_locale_as_is() -> None:
    # Python-хост пропускает только известные ключи конверта: без поля locale он бы её потерял.
    # Сам ход AG-UI здесь не гоняем — пакет ag-ui в dev-зависимости не входит.
    body = {"forwardedProps": {"ai37": {"locale": "ca-ES-valencia"}}}
    assert extract_ai37(body).locale == "ca-ES-valencia"
    assert extract_ai37({"forwardedProps": {"ai37": {"locale": 42}}}).locale is None
    assert extract_ai37({}).locale is None


def test_a2a_parse_keeps_locale_from_message_metadata() -> None:
    meta = _to_ai37_metadata({"locale": "es-MX", "intent": {"skill": "s"}})
    assert meta.locale == "es-MX"
    assert meta.intent is not None and meta.intent.skill == "s"
