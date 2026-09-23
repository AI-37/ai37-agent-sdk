import pytest

from ai37_agent_sdk import AuthError, JwksJwtVerifier
from ai37_agent_sdk.testing import TEST_AUDIENCE, TEST_ISSUER, create_test_keyset

KS = create_test_keyset()


def _verifier() -> JwksJwtVerifier:
    return JwksJwtVerifier(issuer=TEST_ISSUER, audience=TEST_AUDIENCE, jwks=KS.jwks)


def _claims(**overrides):
    return {"sub": "u1", "org_id": "u1", "billing_org_id": "org1", **overrides}


def test_valid_token():
    token = KS.sign(_claims(app_id="sp-ai"))
    claims = _verifier().verify(token)
    assert claims["sub"] == "u1"
    assert claims["billing_org_id"] == "org1"
    assert claims["app_id"] == "sp-ai"


def test_expired_token():
    token = KS.sign(_claims(), expires_in=-3600)
    with pytest.raises(AuthError) as exc:
        _verifier().verify(token)
    assert exc.value.code == "invalid_token"


def test_wrong_audience():
    token = KS.sign(_claims(), audience="someone-else")
    with pytest.raises(AuthError):
        _verifier().verify(token)


def test_wrong_issuer():
    token = KS.sign(_claims(), issuer="https://evil.example/")
    with pytest.raises(AuthError):
        _verifier().verify(token)


def test_missing_required_claim():
    token = KS.sign({"sub": "u1", "org_id": "u1"})  # нет billing_org_id
    with pytest.raises(AuthError) as exc:
        _verifier().verify(token)
    assert exc.value.code == "missing_claim"


def test_unknown_kid_signature_mismatch():
    other = create_test_keyset(kid="other-key")
    token = other.sign(_claims())
    with pytest.raises(AuthError):
        _verifier().verify(token)


def test_config_errors():
    with pytest.raises(AuthError):
        JwksJwtVerifier(issuer="", audience="a", jwks=KS.jwks)
    with pytest.raises(AuthError):
        JwksJwtVerifier(issuer="i", audience="a")  # нет источника ключей


def test_required_claims_default_is_unchanged():
    """Дефолт прежний: арендаторский токен без организации не проходит."""
    token = KS.sign({"sub": "operator-1"})
    with pytest.raises(AuthError) as exc:
        _verifier().verify(token)
    assert exc.value.code == "missing_claim"


def test_required_claims_lets_a_platform_operator_through():
    """Организации у оператора нет, и требовать её значило бы её изготовить."""
    verifier = JwksJwtVerifier(
        issuer=TEST_ISSUER,
        audience=TEST_AUDIENCE,
        jwks=KS.jwks,
        required_claims=["sub"],
    )
    claims = verifier.verify(KS.sign({"sub": "operator-1", "platform_role": "operator"}))
    assert claims["sub"] == "operator-1"
    assert claims["platform_role"] == "operator"


def test_required_claims_still_checks_the_set_it_was_given():
    verifier = JwksJwtVerifier(
        issuer=TEST_ISSUER,
        audience=TEST_AUDIENCE,
        jwks=KS.jwks,
        required_claims=["sub", "platform_role"],
    )
    with pytest.raises(AuthError) as exc:
        verifier.verify(KS.sign({"sub": "operator-1"}))
    assert exc.value.code == "missing_claim"
