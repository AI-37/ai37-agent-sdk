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
