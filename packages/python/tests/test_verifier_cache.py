"""Тесты мемоизации JWT-верификатора в AgentContext.from_request:
один экземпляр на состав настроек, изоляция конфигов, ротация kid,
обход кэша явным ``verifier=``, introspection-канал."""

from __future__ import annotations

import json
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from ai37_agent_sdk import AuthError
from ai37_agent_sdk.context import (
    _VERIFIER_CACHE,
    AgentContext,
    AgentContextSettings,
    AuthSettings,
    BillingSettings,
    _get_or_build_verifier,
    _verifier_cache_key,
)
from ai37_agent_sdk.testing import TEST_AUDIENCE, TEST_ISSUER, create_test_keyset

OTHER_ISSUER = "https://auth.dev.sp-ai.ru/application/o/widgets/"

CLAIMS = {"sub": "u1", "org_id": "u1", "billing_org_id": "org1"}


@pytest.fixture(autouse=True)
def _clean_cache():
    _VERIFIER_CACHE.clear()
    yield
    _VERIFIER_CACHE.clear()


class _CountingServer:
    """Локальный HTTP-сервер со счётчиком обращений (JWKS через GET, introspection через POST)."""

    def __init__(self, body: dict[str, Any]) -> None:
        state = self

        class Handler(BaseHTTPRequestHandler):
            def _respond(self) -> None:
                state.hits += 1
                payload = json.dumps(state.body).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self) -> None:  # noqa: N802 — контракт BaseHTTPRequestHandler
                self._respond()

            def do_POST(self) -> None:  # noqa: N802 — контракт BaseHTTPRequestHandler
                self._respond()

            def log_message(self, *args: Any) -> None:
                pass

        self.body = body
        self.hits = 0
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_port}/"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


@pytest.fixture()
def jwks_env():
    ks = create_test_keyset()
    server = _CountingServer(ks.jwks)
    yield ks, server
    server.close()


def _settings(auth: AuthSettings) -> AgentContextSettings:
    # Свежие объекты на каждый вызов — структурное равенство, не идентичность.
    return AgentContextSettings(
        auth=auth,
        billing=BillingSettings(base_url="http://127.0.0.1:9", apps_auth_token="apps-auth"),
    )


def _auth(jwks_url: str, **overrides: Any) -> AuthSettings:
    return AuthSettings(
        issuer=TEST_ISSUER, audience=TEST_AUDIENCE, jwks_url=jwks_url, **overrides
    )


def _headers(token: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}


def test_same_composition_one_instance():
    a = _auth("http://a/jwks")
    b = _auth("http://a/jwks")
    assert a is not b
    v1 = _get_or_build_verifier(a)
    v2 = _get_or_build_verifier(b)
    assert v1 is v2
    assert len(_VERIFIER_CACHE) == 1


def test_audience_str_vs_list_normalized():
    v1 = _get_or_build_verifier(_auth("http://a/jwks"))
    v2 = _get_or_build_verifier(
        AuthSettings(issuer=TEST_ISSUER, audience=[TEST_AUDIENCE], jwks_url="http://a/jwks")
    )
    assert v1 is v2


def test_each_field_isolates_configs():
    base = AuthSettings(
        issuer=TEST_ISSUER,
        audience=TEST_AUDIENCE,
        jwks_url="http://a/jwks",
        leeway=60,
        introspection_url="http://i/introspect",
        introspection_token="apps-1",
        introspection_cache_ttl_ms=1000,
    )
    variants = [
        replace(base, issuer=OTHER_ISSUER),
        replace(base, audience="other-app"),
        replace(base, jwks_url="http://b/jwks"),
        replace(base, leeway=30),
        replace(base, introspection_url="http://other"),
        replace(base, introspection_token="apps-2"),
        replace(base, introspection_cache_ttl_ms=2000),
    ]
    base_key = _verifier_cache_key(base)
    for variant in variants:
        assert _verifier_cache_key(variant) != base_key
    # required в ключ не входит — на верификатор не влияет.
    assert _verifier_cache_key(replace(base, required=False)) == base_key

    other = _get_or_build_verifier(replace(base, issuer=OTHER_ISSUER))
    assert _get_or_build_verifier(base) is not other


def test_from_request_reuses_verifier_single_jwks_fetch(jwks_env):
    ks, server = jwks_env
    token = ks.sign(CLAIMS)
    ctx1 = AgentContext.from_request(_headers(token), _settings(_auth(server.url)))
    ctx2 = AgentContext.from_request(_headers(token), _settings(_auth(server.url)))
    assert ctx1.claims is not None and ctx1.claims["sub"] == "u1"
    assert ctx2.claims is not None and ctx2.claims["sub"] == "u1"
    assert server.hits == 1


def test_token_of_config_a_rejected_by_config_b(jwks_env):
    ks_a, server_a = jwks_env
    ks_b = create_test_keyset(kid="other-key")
    server_b = _CountingServer(ks_b.jwks)
    try:
        token_a = ks_a.sign(CLAIMS)
        ctx = AgentContext.from_request(_headers(token_a), _settings(_auth(server_a.url)))
        assert ctx.claims is not None
        with pytest.raises(AuthError):
            AgentContext.from_request(
                _headers(token_a),
                _settings(
                    AuthSettings(
                        issuer=OTHER_ISSUER, audience=TEST_AUDIENCE, jwks_url=server_b.url
                    )
                ),
            )
        assert len(_VERIFIER_CACHE) == 2
    finally:
        server_b.close()


def test_kid_rotation_refetches_jwks(jwks_env):
    ks_old, server = jwks_env
    token_old = ks_old.sign(CLAIMS)
    AgentContext.from_request(_headers(token_old), _settings(_auth(server.url)))
    assert server.hits == 1

    # Ротация: эндпоинт отдаёт обновлённый набор; PyJWKClient дозагружает по неизвестному kid.
    ks_new = create_test_keyset(kid="rotated-key")
    server.body = {"keys": ks_old.jwks["keys"] + ks_new.jwks["keys"]}
    token_new = ks_new.sign(CLAIMS)
    ctx = AgentContext.from_request(_headers(token_new), _settings(_auth(server.url)))
    assert ctx.claims is not None and ctx.claims["sub"] == "u1"
    assert server.hits == 2


def test_explicit_verifier_bypasses_cache(jwks_env):
    ks, server = jwks_env

    class FakeVerifier:
        def verify(self, token: str) -> dict[str, Any]:
            return {**CLAIMS, "sub": "override-user"}

    fake = FakeVerifier()
    token = ks.sign(CLAIMS)
    ctx = AgentContext.from_request(
        _headers(token), _settings(_auth(server.url)), verifier=fake
    )
    assert ctx.claims is not None and ctx.claims["sub"] == "override-user"
    assert len(_VERIFIER_CACHE) == 0
    assert server.hits == 0

    # Без override — обычный путь: кэшируется собранный, а не явный.
    ctx2 = AgentContext.from_request(_headers(token), _settings(_auth(server.url)))
    assert ctx2.claims is not None and ctx2.claims["sub"] == "u1"
    assert len(_VERIFIER_CACHE) == 1
    assert fake not in _VERIFIER_CACHE.values()


def test_introspection_channel_reuses_claims_cache():
    intro = _CountingServer(
        {"active": True, "claims": {"sub": "api-user", "org_id": "api-user",
                                    "billing_org_id": "org9"}}
    )
    try:
        auth = AuthSettings(
            issuer=TEST_ISSUER,
            audience=TEST_AUDIENCE,
            introspection_url=intro.url,
            introspection_token="apps-token",
        )
        ctx1 = AgentContext.from_request(_headers("api-key-secret"), _settings(auth))
        assert ctx1.claims is not None and ctx1.claims["billing_org_id"] == "org9"
        assert intro.hits == 1

        # Повтор того же ключа: claims-кэш живого OpaqueTokenVerifier, без второго похода.
        ctx2 = AgentContext.from_request(
            _headers("api-key-secret"),
            _settings(replace(auth)),
        )
        assert ctx2.claims is not None and ctx2.claims["sub"] == "api-user"
        assert intro.hits == 1
        assert len(_VERIFIER_CACHE) == 1
    finally:
        intro.close()
