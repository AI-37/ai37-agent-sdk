from __future__ import annotations

from typing import Any

from ..auth.types import Claims
from ..billing.client import has_required_access
from ..billing.errors import BillingExecutionDeniedError
from ..billing.types import (
    BillingExecutionRequirement,
    BillingRuntimeState,
    BillingUsageEventInput,
)


class FakeJwtVerifier:
    """Возвращает заданные claims без проверки подписи (только для тестов)."""

    def __init__(self, claims: Claims) -> None:
        self._claims = claims

    def verify(self, token: str) -> Claims:  # noqa: ARG002 — токен игнорируется
        return self._claims


class InMemoryBillingClient:
    """In-memory billing-клиент: отдаёт фикстуру runtime state, пишет usage в ``sent_usage``."""

    def __init__(self, *, runtime_state: BillingRuntimeState) -> None:
        self._state = runtime_state
        self.sent_usage: list[dict[str, Any]] = []

    def set_runtime_state(self, state: BillingRuntimeState) -> None:
        self._state = state

    def get_runtime_state_by_billing_org_id(
        self, billing_org_id: str  # noqa: ARG002
    ) -> BillingRuntimeState:
        return self._state

    def assert_execution_allowed(
        self,
        billing_org_id: str,  # noqa: ARG002
        requirement: BillingExecutionRequirement | None = None,
    ) -> BillingRuntimeState:
        s = self._state
        if (
            s.entitlement_status != "active"
            or s.remaining_total_tokens <= 0
            or not has_required_access(s, requirement)
        ):
            raise BillingExecutionDeniedError(s, requirement)
        return s

    def send_usage_event(self, event: BillingUsageEventInput) -> None:
        self.sent_usage.append(
            {
                "transaction_id": event.transaction_id,
                "code": event.code,
                "properties": event.properties or {},
            }
        )
