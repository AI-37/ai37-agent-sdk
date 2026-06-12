from __future__ import annotations

from ..auth.types import Claims
from ..billing.types import BillingClient, BillingRuntimeState
from ..context import AgentContext, AgentContextSettings, AuthSettings, BillingSettings
from .fakes import FakeJwtVerifier, InMemoryBillingClient
from .fixtures import fixtures


def make_test_context(
    *,
    claims: Claims,
    billing: BillingClient | None = None,
    runtime_state: BillingRuntimeState | None = None,
) -> AgentContext:
    """Собирает AgentContext без сети: FakeJwtVerifier + InMemoryBillingClient."""
    billing_client = billing or InMemoryBillingClient(
        runtime_state=runtime_state or fixtures.runtime_state.active()
    )
    return AgentContext.from_request(
        {"authorization": "Bearer test.token"},
        AgentContextSettings(
            auth=AuthSettings(issuer="test", audience="test", required=True),
            billing=BillingSettings(base_url="http://billing.test", apps_auth_token="test"),
        ),
        verifier=FakeJwtVerifier(claims),
        billing_client=billing_client,
    )
