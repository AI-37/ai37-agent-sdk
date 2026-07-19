import pytest

from ai37_agent_sdk import (
    AgentContext,
    AgentContextSettings,
    AuthError,
    AuthSettings,
    BillingSettings,
)
from ai37_agent_sdk.billing import BillingExecutionDeniedError
from ai37_agent_sdk.testing import InMemoryBillingClient, fixtures, make_test_context


def test_billing_org_id_litellm_and_usage():
    billing = InMemoryBillingClient(
        runtime_state=fixtures.runtime_state.active(remaining_total_tokens=500)
    )
    ctx = make_test_context(
        claims={"sub": "u1", "org_id": "u1", "billing_org_id": "org1", "app_id": "sp-ai"},
        billing=billing,
    )
    assert ctx.billing_org_id == "org1"

    state = ctx.assert_execution_allowed()
    assert state.llm_key == "sk-test-llm"
    assert ctx.llm_key == "sk-test-llm"

    ctx.report_usage(transaction_id="t1", code="lift_calculation", properties={"x": 1})
    assert billing.sent_usage == [
        {"transaction_id": "t1", "code": "lift_calculation", "properties": {"x": 1}}
    ]


def test_denied_no_resources():
    ctx = make_test_context(
        claims={"sub": "u1", "org_id": "u1", "billing_org_id": "org1"},
        runtime_state=fixtures.runtime_state.no_resources(),
    )
    with pytest.raises(BillingExecutionDeniedError):
        ctx.assert_execution_allowed()


def test_missing_token_when_required():
    with pytest.raises(AuthError):
        AgentContext.from_request(
            {},
            AgentContextSettings(
                auth=AuthSettings(issuer="i", audience="a", required=True),
                billing=BillingSettings(base_url="http://billing.test"),
            ),
        )


def test_optional_token_skips_auth():
    ctx = AgentContext.from_request(
        {},
        AgentContextSettings(
            auth=AuthSettings(issuer="i", audience="a", required=False),
            billing=BillingSettings(base_url="http://billing.test", apps_auth_token="apps"),
        ),
    )
    assert ctx.claims is None
    assert ctx.billing_org_id is None


def test_org_id_and_role_default_user():
    ctx = make_test_context(
        claims={"sub": "u1", "org_id": "org1", "billing_org_id": "b1"}
    )
    assert ctx.org_id == "org1"
    assert ctx.role == "USER"


def test_role_from_claim():
    ctx = make_test_context(
        claims={"sub": "u1", "org_id": "org1", "billing_org_id": "b1", "org_role": "EDITOR"}
    )
    assert ctx.role == "EDITOR"


def test_assert_role_passes_when_sufficient():
    owner = make_test_context(
        claims={"sub": "u1", "org_id": "org1", "billing_org_id": "b1", "org_role": "OWNER"}
    )
    owner.assert_role("EDITOR")
    owner.assert_role("OWNER")

    editor = make_test_context(
        claims={"sub": "u1", "org_id": "org1", "billing_org_id": "b1", "org_role": "EDITOR"}
    )
    editor.assert_role("EDITOR")
    editor.assert_role("USER")


def test_assert_role_raises_when_insufficient():
    user = make_test_context(
        claims={"sub": "u1", "org_id": "org1", "billing_org_id": "b1"}
    )
    with pytest.raises(AuthError) as exc:
        user.assert_role("EDITOR")
    assert exc.value.code == "forbidden_role"
