from __future__ import annotations

import httpx
import pytest

from ai37_agent_sdk.auth import (
    AuthError,
    CompositeVerifier,
    OpaqueTokenVerifier,
    create_composite_verifier,
    looks_like_jwt,
)
from ai37_agent_sdk.auth.types import Claims

URL = "https://billing.test/internal/api-keys/introspect"
APPS_TOKEN = "apps-token"
OPAQUE_KEY = "ak_opaque_value_without_dots"

ACTIVE_BODY = {
    "active": True,
    "claims": {
        "sub": "user-uuid",
        "org_id": "user-uuid",
        "billing_org_id": "billing-1",
        "email": "u@example.com",
        "name": "User",
        "exp": 1893456000,
    },
}


def _verifier(handler) -> OpaqueTokenVerifier:
    transport = httpx.MockTransport(handler)
    return OpaqueTokenVerifier(
        url=URL,
        apps_token=APPS_TOKEN,
        http_client=httpx.Client(transport=transport),
    )


def test_looks_like_jwt():
    assert looks_like_jwt("aaa.bbb.ccc") is True
    assert looks_like_jwt(OPAQUE_KEY) is False
    assert looks_like_jwt("only.two") is False


def test_active_key_returns_claims():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.headers["Authorization"] == f"Bearer {APPS_TOKEN}"
        return httpx.Response(200, json=ACTIVE_BODY)

    claims = _verifier(handler).verify(OPAQUE_KEY)
    assert claims["sub"] == "user-uuid"
    assert claims["org_id"] == "user-uuid"
    assert claims["billing_org_id"] == "billing-1"
    assert claims["email"] == "u@example.com"


def test_positive_result_is_cached():
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json=ACTIVE_BODY)

    verifier = _verifier(handler)
    verifier.verify(OPAQUE_KEY)
    verifier.verify(OPAQUE_KEY)
    assert calls["n"] == 1


def test_inactive_key_raises():
    verifier = _verifier(lambda req: httpx.Response(200, json={"active": False, "claims": None}))
    with pytest.raises(AuthError):
        verifier.verify(OPAQUE_KEY)


def test_non_200_raises():
    verifier = _verifier(lambda req: httpx.Response(401, json={"detail": "nope"}))
    with pytest.raises(AuthError):
        verifier.verify(OPAQUE_KEY)


def test_missing_claim_raises():
    body = {"active": True, "claims": {"sub": "u", "org_id": "u"}}
    verifier = _verifier(lambda req: httpx.Response(200, json=body))
    with pytest.raises(AuthError) as exc:
        verifier.verify(OPAQUE_KEY)
    assert exc.value.code == "missing_claim"


def test_requires_url_and_token():
    with pytest.raises(AuthError):
        OpaqueTokenVerifier(url="", apps_token=APPS_TOKEN)
    with pytest.raises(AuthError):
        OpaqueTokenVerifier(url=URL, apps_token="")


class _Stub:
    def __init__(self, label: str) -> None:
        self.label = label
        self.calls = 0

    def verify(self, token: str) -> Claims:
        self.calls += 1
        return {"sub": self.label}  # type: ignore[typeddict-item]


def test_composite_routes_jwt():
    jwt = _Stub("jwt")
    opaque = _Stub("opaque")
    composite = CompositeVerifier(jwt=jwt, opaque=opaque)
    claims = composite.verify("aaa.bbb.ccc")
    assert claims["sub"] == "jwt"
    assert jwt.calls == 1
    assert opaque.calls == 0


def test_composite_routes_opaque():
    jwt = _Stub("jwt")
    opaque = _Stub("opaque")
    composite = CompositeVerifier(jwt=jwt, opaque=opaque)
    claims = composite.verify(OPAQUE_KEY)
    assert claims["sub"] == "opaque"
    assert opaque.calls == 1
    assert jwt.calls == 0


def test_composite_missing_channel_raises():
    composite = CompositeVerifier(opaque=_Stub("opaque"))
    with pytest.raises(AuthError) as exc:
        composite.verify("aaa.bbb.ccc")
    assert exc.value.code == "config"


def test_create_composite_returns_jwt_only():
    jwt = _Stub("jwt")
    assert create_composite_verifier(jwt=jwt) is jwt


def test_create_composite_returns_opaque_only():
    verifier = create_composite_verifier(introspection_url=URL, introspection_token=APPS_TOKEN)
    assert isinstance(verifier, OpaqueTokenVerifier)


def test_create_composite_returns_composite():
    verifier = create_composite_verifier(
        jwt=_Stub("jwt"), introspection_url=URL, introspection_token=APPS_TOKEN
    )
    assert isinstance(verifier, CompositeVerifier)


def test_create_composite_requires_a_channel():
    with pytest.raises(AuthError):
        create_composite_verifier()
