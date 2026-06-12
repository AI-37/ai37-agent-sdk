from __future__ import annotations

import json
import time
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

TEST_ISSUER = "https://auth.dev.sp-ai.ru/application/o/sp-ai/"
TEST_AUDIENCE = "sp-ai-web"


class TestKeyset:
    """Локальный RSA keypair + подписанные токены (Уровень 2a — верификация без сети)."""

    def __init__(self, kid: str = "ai37-test-key") -> None:
        self._kid = kid
        self._private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public_jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self._private.public_key()))
        public_jwk["kid"] = kid
        public_jwk["alg"] = "RS256"
        public_jwk["use"] = "sig"
        self._public_jwk = public_jwk

    @property
    def jwks(self) -> dict[str, Any]:
        return {"keys": [self._public_jwk]}

    def sign(
        self,
        claims: dict[str, Any],
        *,
        issuer: str | None = None,
        audience: str | None = None,
        expires_in: int = 3600,
        kid: str | None = None,
    ) -> str:
        now = int(time.time())
        payload = {
            **claims,
            "iss": issuer or TEST_ISSUER,
            "aud": audience or TEST_AUDIENCE,
            "iat": now,
            "exp": now + expires_in,
        }
        return jwt.encode(
            payload, self._private, algorithm="RS256", headers={"kid": kid or self._kid}
        )


def create_test_keyset(kid: str = "ai37-test-key") -> TestKeyset:
    return TestKeyset(kid)


_default: TestKeyset | None = None


def _get_default() -> TestKeyset:
    global _default
    if _default is None:
        _default = create_test_keyset()
    return _default


def make_test_token(claims: dict[str, Any], **kwargs: Any) -> str:
    return _get_default().sign(claims, **kwargs)


def test_jwks() -> dict[str, Any]:
    return _get_default().jwks
