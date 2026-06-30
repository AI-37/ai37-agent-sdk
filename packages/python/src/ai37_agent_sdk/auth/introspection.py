"""Верификация непрозрачных (opaque) пользовательских API-ключей через introspection-эндпоинт
billing-microservice. Ключ — не JWT; identity (sub/org_id/billing_org_id) резолвит billing
(свой registry + Authentik liveness). Положительные результаты кэшируются по sha256(key)."""

from __future__ import annotations

import hashlib
import time
from typing import Any

import httpx

from .errors import AuthError
from .types import Claims, JwtVerifier

_DEFAULT_TTL_MS = 3_600_000
_DEFAULT_TIMEOUT_MS = 5000


def looks_like_jwt(token: str) -> bool:
    """Похоже ли на JWT (3 сегмента) — эвристика для роутинга JWT vs opaque."""
    return token.count(".") == 2


def _to_claims(raw: dict[str, Any]) -> Claims:
    sub = raw.get("sub")
    org_id = raw.get("org_id")
    billing_org_id = raw.get("billing_org_id")
    if not isinstance(sub, str) or not sub:
        raise AuthError("Introspection response missing claim: sub", "missing_claim")
    if not isinstance(org_id, str) or not org_id:
        raise AuthError("Introspection response missing claim: org_id", "missing_claim")
    if not isinstance(billing_org_id, str) or not billing_org_id:
        raise AuthError(
            "Introspection response missing claim: billing_org_id", "missing_claim"
        )
    exp = raw.get("exp")
    # iss/aud/iat синтезируем — downstream использует только sub/org_id/billing_org_id.
    claims: Claims = {
        "iss": "urn:ai37:api-key",
        "aud": "ai37-agents",
        "sub": sub,
        "org_id": org_id,
        "billing_org_id": billing_org_id,
        "exp": exp if isinstance(exp, int) else 0,
        "iat": 0,
    }
    email = raw.get("email")
    if isinstance(email, str) and email:
        claims["email"] = email
    name = raw.get("name")
    if isinstance(name, str) and name:
        claims["name"] = name
    return claims


class OpaqueTokenVerifier:
    """Верификатор opaque-ключей через introspection-эндпоинт billing (синхронный httpx).

    Кэширует только положительные результаты по sha256(key) на ``cache_ttl_ms`` (дефолт 1ч —
    безопасно: исполнение гейтит billing runtime state). Отрицательные ответы кэширует сам billing.
    """

    def __init__(
        self,
        *,
        url: str,
        apps_token: str,
        cache_ttl_ms: int = _DEFAULT_TTL_MS,
        timeout_ms: int = _DEFAULT_TIMEOUT_MS,
        http_client: httpx.Client | None = None,
    ) -> None:
        if not url or not url.strip():
            raise AuthError("OpaqueTokenVerifier: url is required", "config")
        if not apps_token or not apps_token.strip():
            raise AuthError("OpaqueTokenVerifier: apps_token is required", "config")
        self._url = url
        self._apps_token = apps_token
        self._ttl_ms = max(cache_ttl_ms, 1)
        self._client = http_client or httpx.Client(timeout=timeout_ms / 1000)
        self._cache: dict[str, tuple[float, Claims]] = {}

    def verify(self, token: str) -> Claims:
        if not token or not token.strip():
            raise AuthError("Empty bearer token")
        key_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now_ms = time.monotonic() * 1000
        cached = self._cache.get(key_hash)
        if cached is not None and cached[0] > now_ms:
            return cached[1]
        claims = self._introspect(token)
        self._cache[key_hash] = (now_ms + self._ttl_ms, claims)
        return claims

    def _introspect(self, token: str) -> Claims:
        try:
            response = self._client.post(
                self._url,
                headers={
                    "Authorization": f"Bearer {self._apps_token}",
                    "Content-Type": "application/json",
                },
                json={"key": token},
            )
        except AuthError:
            raise
        except Exception as cause:  # noqa: BLE001 — любая транспортная ошибка → AuthError
            raise AuthError(
                "API key introspection request failed", "invalid_token", cause=cause
            ) from cause
        if response.status_code != 200:
            raise AuthError(
                f"API key introspection failed: status={response.status_code}",
                "invalid_token",
            )
        body = response.json()
        claims = body.get("claims") if isinstance(body, dict) else None
        if not isinstance(body, dict) or not body.get("active") or not isinstance(claims, dict):
            raise AuthError("API key is not active", "invalid_token")
        return _to_claims(claims)


class CompositeVerifier:
    """Маршрутизирует по форме токена: JWT → jwt.verify (JWKS), иначе → opaque.verify."""

    def __init__(
        self,
        *,
        jwt: JwtVerifier | None = None,
        opaque: JwtVerifier | None = None,
    ) -> None:
        self._jwt = jwt
        self._opaque = opaque

    def verify(self, token: str) -> Claims:
        if not token or not token.strip():
            raise AuthError("Empty bearer token")
        if looks_like_jwt(token):
            if self._jwt is None:
                raise AuthError("CompositeVerifier: no JWT verifier configured", "config")
            return self._jwt.verify(token)
        if self._opaque is None:
            raise AuthError("CompositeVerifier: no opaque verifier configured", "config")
        return self._opaque.verify(token)


def create_composite_verifier(
    *,
    jwt: JwtVerifier | None = None,
    introspection_url: str | None = None,
    introspection_token: str | None = None,
    introspection_cache_ttl_ms: int | None = None,
) -> JwtVerifier:
    """Собирает верификатор из JWT- и/или introspection-канала; один канал возвращается напрямую."""
    opaque: JwtVerifier | None = None
    if introspection_url:
        opaque = OpaqueTokenVerifier(
            url=introspection_url,
            apps_token=introspection_token or "",
            cache_ttl_ms=(
                introspection_cache_ttl_ms
                if introspection_cache_ttl_ms is not None
                else _DEFAULT_TTL_MS
            ),
        )
    if jwt is None and opaque is None:
        raise AuthError(
            "create_composite_verifier: at least one of jwt/introspection is required",
            "config",
        )
    if jwt is not None and opaque is None:
        return jwt
    if jwt is None and opaque is not None:
        return opaque
    return CompositeVerifier(jwt=jwt, opaque=opaque)
