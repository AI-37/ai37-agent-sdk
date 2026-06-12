import json

import httpx
import pytest

from ai37_agent_sdk import (
    BillingExecutionRequirement,
    BillingRequestError,
    create_billing_client,
)
from ai37_agent_sdk.billing import BillingExecutionDeniedError
from ai37_agent_sdk.billing.types import BillingUsageEventInput

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
