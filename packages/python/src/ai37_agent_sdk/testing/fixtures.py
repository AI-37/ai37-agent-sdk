from __future__ import annotations

from dataclasses import replace
from typing import Any

from ..billing.types import (
    BillingRuntimeFeature,
    BillingRuntimePrivilege,
    BillingRuntimeState,
)

_BASE = BillingRuntimeState(
    org_id="org-test",
    billing_org_id="billing-org-test",
    entitlement_status="active",
    remaining_total_tokens=1000,
    features=[],
    llm_key="sk-test-llm",
    stale=False,
)


def _active(**overrides: Any) -> BillingRuntimeState:
    return replace(_BASE, **overrides)


def _no_resources(**overrides: Any) -> BillingRuntimeState:
    return replace(
        _BASE, entitlement_status="no_resources", remaining_total_tokens=0, **overrides
    )


def _trial(**overrides: Any) -> BillingRuntimeState:
    return replace(
        _BASE,
        current_subscription_status="trialing",
        trial_ends_at="2030-01-01T00:00:00Z",
        **overrides,
    )


def _feature_grant(feature: str, privilege: str, value: bool) -> BillingRuntimeFeature:
    return BillingRuntimeFeature(
        code=feature,
        privileges=[
            BillingRuntimePrivilege(code=privilege, value=value, value_type="boolean", config={})
        ],
    )


def _feature_allowed(feature: str, privilege: str, **overrides: Any) -> BillingRuntimeState:
    return replace(_BASE, features=[_feature_grant(feature, privilege, True)], **overrides)


def _feature_denied(feature: str, privilege: str, **overrides: Any) -> BillingRuntimeState:
    return replace(_BASE, features=[_feature_grant(feature, privilege, False)], **overrides)


class _RuntimeStateFixtures:
    active = staticmethod(_active)
    no_resources = staticmethod(_no_resources)
    trial = staticmethod(_trial)
    feature_allowed = staticmethod(_feature_allowed)
    feature_denied = staticmethod(_feature_denied)


class _Fixtures:
    runtime_state = _RuntimeStateFixtures()


fixtures = _Fixtures()
