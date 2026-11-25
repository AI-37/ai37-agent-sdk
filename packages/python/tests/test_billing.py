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
)
from ai37_agent_sdk.billing import BillingExecutionDeniedError
from ai37_agent_sdk.billing.types import (
    BillingRuntimeState,
    BillingRuntimeSubject,
    BillingUsageEventInput,
)
from ai37_agent_sdk.testing import InMemoryBillingClient, fixtures

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


def test_assert_denied_payment_failed_status():
    # Токены есть, но entitlement_status=payment_failed (!= active) → отказ, причина PAYMENT_FAILED.
    body = {**ACTIVE, "entitlementStatus": "payment_failed"}
    client = _client(lambda req: httpx.Response(200, json=body))
    with pytest.raises(BillingExecutionDeniedError) as exc:
        client.assert_execution_allowed("org1")
    assert exc.value.reason == "PAYMENT_FAILED"


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


# --- state по организации (by-org): DS знает только org_id пула проекта ---


def _cached_client(handler, ttl_ms: int = 10_000):
    return create_billing_client(
        base_url="http://billing.test/api/v1/",
        auth_token="ds-apps",
        usage_ingest_token="ds-apps",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        runtime_state_cache_ttl_ms=ttl_ms,
    )


def test_state_by_org_id_uses_by_org_route():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.headers["authorization"] == "Bearer ds-apps"
        assert str(req.url) == "http://billing.test/api/v1/billing/customers/by-org/org-1/state"
        return httpx.Response(200, json=ACTIVE)

    state = _cached_client(handler).get_runtime_state_by_org_id("org-1")
    assert state.billing_org_id == "org1"
    assert state.entitlement_status == "active"


def test_state_by_org_id_encodes_id():
    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req.url.raw_path.decode())
        return httpx.Response(200, json=ACTIVE)

    _cached_client(handler).get_runtime_state_by_org_id("org/1?x=#y")
    assert seen == ["/api/v1/billing/customers/by-org/org%2F1%3Fx%3D%23y/state"]


def test_state_by_org_id_is_cached_within_ttl():
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.url.path)
        return httpx.Response(200, json=ACTIVE)

    client = _cached_client(handler)
    first = client.get_runtime_state_by_org_id("org-1")
    second = client.get_runtime_state_by_org_id("org-1")
    assert second == first
    assert len(calls) == 1


def test_state_by_org_id_not_cached_when_ttl_is_zero():
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.url.path)
        return httpx.Response(200, json=ACTIVE)

    client = _cached_client(handler, ttl_ms=0)
    client.get_runtime_state_by_org_id("org-1")
    client.get_runtime_state_by_org_id("org-1")
    assert len(calls) == 2


def test_state_cache_keeps_by_org_and_by_billing_org_apart():
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.url.path)
        route = "by-org" if "/by-org/" in req.url.path else "by-billing-org"
        return httpx.Response(200, json={**ACTIVE, "currentPlanCode": f"{route}-plan"})

    client = _cached_client(handler)
    by_billing_org = client.get_runtime_state_by_billing_org_id("same-id")
    by_org = client.get_runtime_state_by_org_id("same-id")
    by_billing_org_again = client.get_runtime_state_by_billing_org_id("same-id")

    assert by_billing_org.current_plan_code == "by-billing-org-plan"
    assert by_org.current_plan_code == "by-org-plan"
    assert by_billing_org_again.current_plan_code == "by-billing-org-plan"
    assert len(calls) == 2


def test_state_by_org_id_error_names_org_and_is_not_cached():
    responses = [
        httpx.Response(404, json={"detail": "org not found: org-1"}),
        httpx.Response(200, json=ACTIVE),
    ]

    client = _cached_client(lambda req: responses.pop(0))
    with pytest.raises(BillingRequestError) as exc:
        client.get_runtime_state_by_org_id("org-1")
    assert exc.value.status == 404
    assert "Billing state request failed for orgId=org-1: HTTP 404" in str(exc.value)

    assert client.get_runtime_state_by_org_id("org-1").entitlement_status == "active"


def test_in_memory_fake_serves_state_by_org_id():
    state = BillingRuntimeState.from_api(ACTIVE)
    fake = InMemoryBillingClient(runtime_state=state)
    assert fake.get_runtime_state_by_org_id("any-org") is state


# --- блок subject: роль и группы пользователя, кэш по (маршрут, id, subject) ---


def _subject_aware_handler(groups_by_user: dict[str, list[str]], seen: list[str]):
    # Billing отдаёт блок subject только на запрос с ?subject=; фейк повторяет это по URL.
    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req.url.raw_path.decode())
        sub = req.url.params.get("subject")
        body = dict(ACTIVE)
        if sub is not None:
            body["subject"] = {
                "user_uuid": sub,
                "role": "EDITOR",
                "group_ids": groups_by_user.get(sub, []),
                "member": sub in groups_by_user,
            }
        return httpx.Response(200, json=body)

    return handler


def test_two_users_of_one_org_get_their_own_groups_from_cache():
    seen: list[str] = []
    client = _cached_client(
        _subject_aware_handler({"alice": ["g-design"], "bob": ["g-sales"]}, seen)
    )

    alice = client.get_runtime_state_by_org_id("org-1", subject="alice")
    bob = client.get_runtime_state_by_org_id("org-1", subject="bob")
    alice_again = client.get_runtime_state_by_org_id("org-1", subject="alice")

    assert alice.subject == BillingRuntimeSubject(
        user_uuid="alice", role="EDITOR", group_ids=["g-design"], member=True
    )
    assert bob.subject is not None and bob.subject.group_ids == ["g-sales"]
    assert alice_again.subject is not None and alice_again.subject.group_ids == ["g-design"]
    assert len(seen) == 2


def test_cache_keeps_requests_with_and_without_subject_apart():
    seen: list[str] = []
    client = _cached_client(_subject_aware_handler({"alice": ["g-design"]}, seen))

    plain = client.get_runtime_state_by_org_id("org-1")
    with_subject = client.get_runtime_state_by_org_id("org-1", subject="alice")
    plain_again = client.get_runtime_state_by_org_id("org-1")

    assert plain.subject is None
    assert with_subject.subject is not None and with_subject.subject.user_uuid == "alice"
    assert plain_again.subject is None
    assert len(seen) == 2


def test_subject_goes_to_query_encoded_on_both_routes():
    seen: list[str] = []
    client = _cached_client(_subject_aware_handler({}, seen))

    client.get_runtime_state_by_org_id("org/1", subject="a b&c=d#e")
    client.get_runtime_state_by_billing_org_id("bo-1", subject="u:1")

    assert seen == [
        "/api/v1/billing/customers/by-org/org%2F1/state?subject=a%20b%26c%3Dd%23e",
        "/api/v1/billing/customers/by-billing-org/bo-1/state?subject=u%3A1",
    ]


def test_empty_subject_is_no_subject():
    seen: list[str] = []
    client = _cached_client(_subject_aware_handler({}, seen))

    client.get_runtime_state_by_org_id("org-1", subject="")
    client.get_runtime_state_by_org_id("org-1")

    assert seen == ["/api/v1/billing/customers/by-org/org-1/state"]


def test_subject_block_parses_non_member_and_camelcase():
    eve = BillingRuntimeState.from_api(
        {**ACTIVE, "subject": {"user_uuid": "eve", "role": None, "group_ids": [], "member": False}}
    )
    ann = BillingRuntimeState.from_api(
        {
            **ACTIVE,
            "subject": {"userUuid": "ann", "role": "OWNER", "groupIds": ["g-1"], "member": True},
        }
    )

    assert eve.subject == BillingRuntimeSubject(user_uuid="eve")
    assert ann.subject == BillingRuntimeSubject(
        user_uuid="ann", role="OWNER", group_ids=["g-1"], member=True
    )


def test_state_without_subject_block_parses_as_before():
    # Сервер без поддержки параметра просто не присылает блок.
    client = _cached_client(lambda req: httpx.Response(200, json=ACTIVE))

    state = client.get_runtime_state_by_org_id("org-1", subject="alice")

    assert state == BillingRuntimeState.from_api(ACTIVE)
    assert state.subject is None


def test_assert_execution_allowed_forwards_subject():
    seen: list[str] = []
    client = _cached_client(_subject_aware_handler({"alice": ["g-design"]}, seen))

    state = client.assert_execution_allowed("org-1", subject="alice")

    assert seen == ["/api/v1/billing/customers/by-billing-org/org-1/state?subject=alice"]
    assert state.subject is not None and state.subject.group_ids == ["g-design"]


def test_in_memory_fake_serves_subjects_per_user():
    fake = InMemoryBillingClient(
        runtime_state=fixtures.runtime_state.active(),
        subjects=[fixtures.subject.member(user_uuid="alice", group_ids=["g-design"])],
    )
    fake.set_subject(fixtures.subject.member(user_uuid="bob", role="OWNER"))

    alice = fake.get_runtime_state_by_org_id("org", subject="alice")
    bob = fake.assert_execution_allowed("bo", subject="bob")
    stranger = fake.get_runtime_state_by_billing_org_id("bo", subject="eve")
    plain = fake.get_runtime_state_by_org_id("org")

    assert alice.subject is not None and alice.subject.group_ids == ["g-design"]
    assert bob.subject is not None and bob.subject.role == "OWNER"
    assert stranger.subject == fixtures.subject.not_member(user_uuid="eve")
    assert plain.subject is None


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


def test_explain_denial_maps_entitlement_status_to_reason():
    # payment_failed → PAYMENT_FAILED (даже когда токены есть); no_resources → NO_TOKENS.
    reason, detail = explain_denial(
        _state(entitlementStatus="payment_failed", remainingTotalTokens=100), _REQ
    )
    assert reason == "PAYMENT_FAILED"
    assert "entitlement_status=payment_failed" in detail
    assert explain_denial(_state(entitlementStatus="no_resources"), _REQ)[0] == "NO_TOKENS"


def test_billing_user_message_payment_and_fallback():
    err = BillingExecutionDeniedError(_state(entitlementStatus="payment_failed"), _REQ)
    assert err.reason == "PAYMENT_FAILED"
    assert friendly_billing_message(err) == BILLING_USER_MESSAGES["PAYMENT_FAILED"]
    assert "Платёж не прошёл" in friendly_billing_message(err)
    # Голая причина — для собственных preflight-веток агента; неизвестное → дефолт.
    assert billing_user_message("NO_TOKENS") == BILLING_USER_MESSAGES["NO_TOKENS"]
    assert billing_user_message("WAT_UNKNOWN") == DEFAULT_BILLING_USER_MESSAGE
    assert billing_user_message(None) == DEFAULT_BILLING_USER_MESSAGE
