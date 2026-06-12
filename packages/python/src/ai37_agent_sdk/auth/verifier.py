from __future__ import annotations

from collections.abc import Callable
from typing import Any

import jwt
from jwt import PyJWKClient, PyJWKSet

from .errors import AuthError
from .types import Claims

KeyResolver = Callable[[str], Any]

_REQUIRED_CLAIMS = ("sub", "org_id", "billing_org_id")


class JwksJwtVerifier:
    """Верификатор user-JWT через JWKS (PyJWT). Источник ключей — удалённый ``jwks_url``,
    локальный набор ``jwks`` или инъекция ``key_resolver`` (приоритет)."""

    def __init__(
        self,
        *,
        issuer: str,
        audience: str | list[str],
        jwks_url: str | None = None,
        jwks: dict[str, Any] | None = None,
        key_resolver: KeyResolver | None = None,
        leeway: int = 60,
        algorithms: list[str] | None = None,
    ) -> None:
        if not issuer or not issuer.strip():
            raise AuthError("JwtVerifier: issuer is required", "config")
        if audience is None or (isinstance(audience, list) and not audience):
            raise AuthError("JwtVerifier: audience is required", "config")

        self._issuer = issuer
        self._audience = audience
        self._leeway = leeway
        self._algorithms = algorithms or ["RS256"]

        if key_resolver is not None:
            self._resolver: KeyResolver = key_resolver
        elif jwks is not None:
            jwkset = PyJWKSet.from_dict(jwks)
            self._resolver = self._make_local_resolver(jwkset)
        elif jwks_url is not None:
            client = PyJWKClient(jwks_url)
            self._resolver = lambda token: client.get_signing_key_from_jwt(token).key
        else:
            raise AuthError(
                "JwtVerifier: one of jwks_url, jwks or key_resolver is required",
                "config",
            )

    @staticmethod
    def _make_local_resolver(jwkset: PyJWKSet) -> KeyResolver:
        def resolve(token: str) -> Any:
            kid = jwt.get_unverified_header(token).get("kid")
            for key in jwkset.keys:
                if key.key_id == kid:
                    return key.key
            if len(jwkset.keys) == 1:
                return jwkset.keys[0].key
            raise AuthError("JWT verification failed: unknown kid", "invalid_token")

        return resolve

    def verify(self, token: str) -> Claims:
        if not token or not token.strip():
            raise AuthError("Empty bearer token")

        try:
            key = self._resolver(token)
            payload = jwt.decode(
                token,
                key,
                algorithms=self._algorithms,
                issuer=self._issuer,
                audience=self._audience,
                leeway=self._leeway,
            )
        except AuthError:
            raise
        except Exception as cause:  # noqa: BLE001 — любая ошибка верификации → AuthError
            raise AuthError("JWT verification failed", "invalid_token", cause=cause) from cause

        for required in _REQUIRED_CLAIMS:
            value = payload.get(required)
            if not isinstance(value, str) or not value:
                raise AuthError(f"JWT missing required claim: {required}", "missing_claim")

        return payload  # type: ignore[return-value]


def create_jwt_verifier(**kwargs: Any) -> JwksJwtVerifier:
    return JwksJwtVerifier(**kwargs)
