from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .types import BillingRuntimeState


class BillingConfigurationError(Exception):
    pass


class BillingRequestError(Exception):
    def __init__(self, message: str, status: int, body: Any) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class BillingExecutionDeniedError(Exception):
    def __init__(self, state: BillingRuntimeState) -> None:
        super().__init__(
            "BILLING_NO_RESOURCES: "
            f"entitlement_status={state.entitlement_status}, "
            f"remaining_total_tokens={state.remaining_total_tokens}"
        )
        self.state = state
