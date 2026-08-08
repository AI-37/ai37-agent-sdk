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


# Единый источник текстов биллинг-ошибок для чата. Агенты НЕ конструируют строки сами — берут
# отсюда, а полную диагностику пишут в логи/трейс. Ключ — машиночитаемая причина отказа.
BILLING_USER_MESSAGES: dict[BillingDenialReason, str] = {
    "PAYMENT_FAILED": "Платёж не прошёл — обновите способ оплаты.",
    "NO_TOKENS": "Достигнут лимит использования — обратитесь к владельцу.",
    "ENTITLEMENT_INACTIVE": "Подписка неактивна — обратитесь к владельцу.",
    "MISSING_FEATURE": "Этот ассистент недоступен для текущей подписки.",
    "MISSING_PRIVILEGE": "Этот ассистент недоступен для текущей подписки.",
}

# Общий fallback, когда причина неизвестна (не BillingExecutionDeniedError или своя ветка агента).
DEFAULT_BILLING_USER_MESSAGE = "Доступ к ассистенту недоступен — проверьте подписку."


def billing_user_message(reason_or_err: object) -> str:
    """Дружелюбный текст по причине ИЛИ по ошибке.

    Агенты зовут его и для СВОИХ preflight-веток (напр. billing_user_message("NO_TOKENS") для
    порога токенов), не собирая BillingExecutionDeniedError. None/неизвестная причина →
    DEFAULT_BILLING_USER_MESSAGE.
    """
    if isinstance(reason_or_err, str):
        reason: str | None = reason_or_err
    elif isinstance(reason_or_err, BillingExecutionDeniedError):
        reason = reason_or_err.reason
    else:
        reason = None
    for key, text in BILLING_USER_MESSAGES.items():
        if key == reason:
            return text
    return DEFAULT_BILLING_USER_MESSAGE


def friendly_billing_message(err: object) -> str:
    """Безопасный для конечного пользователя текст по причине отказа (без биллинг-внутренностей).

    Тонкая обёртка над billing_user_message — оставлена ради обратной совместимости импортов.
    """
    return billing_user_message(err)
