from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .access import BillingDenialReason, explain_denial

if TYPE_CHECKING:
    from .types import BillingExecutionRequirement, BillingRuntimeState


class BillingConfigurationError(Exception):
    pass


class BillingRequestError(Exception):
    def __init__(self, message: str, status: int, body: Any) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class BillingExecutionDeniedError(Exception):
    def __init__(
        self,
        state: BillingRuntimeState,
        requirement: BillingExecutionRequirement | None = None,
    ) -> None:
        # Называем РЕАЛЬНУЮ причину (не всегда «нет ресурсов»): неактивный entitlement, нет токенов,
        # отсутствующая фича или непредоставленная привилегия — с деталями для отладки.
        denial = explain_denial(state, requirement)
        if denial is None:
            reason: BillingDenialReason = "NO_TOKENS"
            detail = f"remaining_total_tokens={state.remaining_total_tokens}"
        else:
            reason, detail = denial
        super().__init__(f"BILLING_DENIED[{reason}]: {detail}")
        self.state = state
        self.requirement = requirement
        self.reason: BillingDenialReason = reason


def friendly_billing_message(err: object) -> str:
    """Безопасный для конечного пользователя текст по причине отказа (без биллинг-внутренностей).

    Агенты показывают его в чате, а полную диагностику пишут в логи/трейс.
    """
    reason = err.reason if isinstance(err, BillingExecutionDeniedError) else None
    if reason == "NO_TOKENS":
        return "Достигнут лимит использования — обратитесь к владельцу."
    if reason == "ENTITLEMENT_INACTIVE":
        return "Подписка неактивна — обратитесь к владельцу."
    if reason in ("MISSING_FEATURE", "MISSING_PRIVILEGE"):
        return "Этот ассистент недоступен для текущей подписки."
    return "Доступ к ассистенту недоступен — проверьте подписку."
