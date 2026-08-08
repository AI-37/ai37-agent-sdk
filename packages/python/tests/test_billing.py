import json

import httpx
import pytest

from ai37_agent_sdk import (
    BILLING_USER_MESSAGES,
    DEFAULT_BILLING_USER_MESSAGE,
    BillingExecutionRequirement,
    BillingRequestError,
    billing_user_message,
    create_billing_client,
    explain_denial,
    friendly_billing_message,
    is_payment_blocked,
)
from ai37_agent_sdk.billing import BillingExecutionDeniedError
from ai37_agent_sdk.billing.types import BillingRuntimeState, BillingUsageEventInput

ACTIVE = {
    "orgId": "u1",
    "billingOrgId": "org1",
    "entitlementStatus": "active",
    "remainingTotalTokens": 100,
    "features": [],
    "llmKey": "sk-x",
    "stale": False,
}


def _client(handler):
    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport)
    return create_billing_client(
        base_url="http://billing.test",
        auth_token="tok",
        usage_ingest_token="apps",
        http_client=http,
        runtime_state_cache_ttl_ms=0,
    )


def test_get_state_parses_camelcase():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.headers["authorization"] == "Bearer tok"
        assert req.url.path.endswith("/by-billing-org/org1/state")
        return httpx.Response(200, json=ACTIVE)

    state = _client(handler).get_runtime_state_by_billing_org_id("org1")
    assert state.org_id == "u1"
    assert state.billing_org_id == "org1"
    assert state.remaining_total_tokens == 100
    assert state.llm_key == "sk-x"


def test_assert_allowed():
    state = _client(lambda req: httpx.Response(200, json=ACTIVE)).assert_execution_allowed("org1")
    assert state.entitlement_status == "active"


def test_assert_denied_no_resources():
    body = {**ACTIVE, "entitlementStatus": "no_resources", "remainingTotalTokens": 0}
    client = _client(lambda req: httpx.Response(200, json=body))
    with pytest.raises(BillingExecutionDeniedError):
        client.assert_execution_allowed("org1")


def test_assert_denied_payment_blocked():
    # Всё остальное в порядке — блокирует именно оплата.
    body = {**ACTIVE, "activePaymentStatus": False}
    client = _client(lambda req: httpx.Response(200, json=body))
    with pytest.raises(BillingExecutionDeniedError) as exc:
        client.assert_execution_allowed("org1")
    assert exc.value.reason == "PAYMENT_FAILED"


def test_assert_allowed_when_payment_healthy():
    body = {**ACTIVE, "activePaymentStatus": True}
    state = _client(lambda req: httpx.Response(200, json=body)).assert_execution_allowed("org1")
    assert state.active_payment_status is True


def test_feature_required():
    granted = {
        **ACTIVE,
        "features": [
            {
                "code": "f1",
                "privileges": [
                    {"code": "p1", "value": True, "valueType": "boolean", "config": {}}
                ],
            }
        ],
    }
    ok = _client(lambda req: httpx.Response(200, json=granted))
    assert ok.assert_execution_allowed(
        "org1", BillingExecutionRequirement(feature="f1", privilege="p1")
    )

    denied = _client(lambda req: httpx.Response(200, json=ACTIVE))  # нет фичи
    with pytest.raises(BillingExecutionDeniedError):
        denied.assert_execution_allowed(
            "org1", BillingExecutionRequirement(feature="f1", privilege="p1")
        )


def test_usage_event_payload():
    captured: dict[str, bytes] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/events"):
            assert req.headers["authorization"] == "Bearer apps"
            captured["body"] = req.content
            return httpx.Response(200, json={})
        return httpx.Response(200, json=ACTIVE)

    client = _client(handler)
    state = client.get_runtime_state_by_billing_org_id("org1")
    client.send_usage_event(
        BillingUsageEventInput(
            transaction_id="t1",
            billing_runtime_state=state,
            code="lift_calculation",
            properties={"a": 1},
        )
    )
    event = json.loads(captured["body"])["event"]
    assert event["transaction_id"] == "t1"
    assert event["external_customer_id"] == "u1"
    assert event["code"] == "lift_calculation"
    assert event["properties"] == {"a": 1}


def test_request_error():
    client = _client(lambda req: httpx.Response(500, json={"detail": "boom"}))
    with pytest.raises(BillingRequestError) as exc:
        client.get_runtime_state_by_billing_org_id("org1")
    assert exc.value.status == 500


# --- информативность отказа (explain_denial / BillingExecutionDeniedError / friendly) ---

def _priv(value: object) -> dict:
    return {
        "code": "elevator-calc-allowed",
        "value": value,
        "valueType": "boolean",
        "config": {},
    }


_ELEV_FEATURE = {"code": "elevator-calc-agent", "privileges": [_priv(True)]}


def _state(**overrides) -> BillingRuntimeState:
    base = {**ACTIVE, "features": [_ELEV_FEATURE]}
    base.update(overrides)
    return BillingRuntimeState.from_api(base)


_REQ = BillingExecutionRequirement(
    feature="elevator-calc-agent", privilege="elevator-calc-allowed"
)


def test_explain_denial_returns_none_when_allowed():
    assert explain_denial(_state(), _REQ) is None


def test_explain_denial_names_missing_feature_with_granted_list():
    reason, detail = explain_denial(_state(features=[]), _REQ)
    assert reason == "MISSING_FEATURE"
    assert "required feature=elevator-calc-agent" in detail
    assert "granted: []" in detail


def test_explain_denial_names_missing_privilege():
    denied = _state(
        features=[{"code": "elevator-calc-agent", "privileges": [_priv(False)]}]
    )
    reason, _ = explain_denial(denied, _REQ)
    assert reason == "MISSING_PRIVILEGE"


def test_explain_denial_inactive_and_no_tokens():
    assert explain_denial(_state(entitlementStatus="suspended"), _REQ)[0] == "ENTITLEMENT_INACTIVE"
    assert explain_denial(_state(remainingTotalTokens=0), _REQ)[0] == "NO_TOKENS"


def test_error_message_is_truthful_and_structured():
    err = BillingExecutionDeniedError(_state(features=[]), _REQ)
    assert err.reason == "MISSING_FEATURE"
    assert err.requirement is _REQ
    assert str(err) == (
        "BILLING_DENIED[MISSING_FEATURE]: required feature=elevator-calc-agent "
        "not granted (granted: [])"
    )
    assert "BILLING_NO_RESOURCES" not in str(err)


def test_friendly_message_hides_internals():
    err = BillingExecutionDeniedError(_state(features=[]), _REQ)
    msg = friendly_billing_message(err)
    assert "feature=" not in msg and "elevator-calc-agent" not in msg
    assert friendly_billing_message(Exception("boom")).endswith("подписку.")


def test_explain_denial_payment_failed_takes_priority():
    # Оплата провалена И entitlement неактивен И токенов нет: побеждает оплата.
    denied = _state(
        activePaymentStatus=False,
        entitlementStatus="no_resources",
        remainingTotalTokens=0,
        features=[],
    )
    reason, detail = explain_denial(denied, _REQ)
    assert reason == "PAYMENT_FAILED"
    assert "active_payment_status=false" in detail


def test_is_payment_blocked_reads_only_explicit_false():
    assert is_payment_blocked(_state(activePaymentStatus=False)) is True
    assert is_payment_blocked(_state(activePaymentStatus=True)) is False
    assert is_payment_blocked(_state()) is False  # отсутствие = разрешено


def test_billing_user_message_payment_and_fallback():
    err = BillingExecutionDeniedError(_state(activePaymentStatus=False), _REQ)
    assert err.reason == "PAYMENT_FAILED"
    assert friendly_billing_message(err) == BILLING_USER_MESSAGES["PAYMENT_FAILED"]
    assert "Платёж не прошёл" in friendly_billing_message(err)
    # Голая причина — для собственных preflight-веток агента; неизвестное → дефолт.
    assert billing_user_message("NO_TOKENS") == BILLING_USER_MESSAGES["NO_TOKENS"]
    assert billing_user_message("WAT_UNKNOWN") == DEFAULT_BILLING_USER_MESSAGE
    assert billing_user_message(None) == DEFAULT_BILLING_USER_MESSAGE
