from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..locale import LEGACY_DEFAULT_LOCALE, t
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


# Единый источник текстов биллинг-ошибок для чата, по языкам. Агенты НЕ конструируют строки сами —
# берут отсюда через billing_user_message, а полную диагностику пишут в логи/трейс. Ключ —
# машиночитаемая причина отказа. Русский — источник истины, остальные языки переводятся с него.
BILLING_USER_MESSAGES_BY_LOCALE: dict[BillingDenialReason, dict[str, str]] = {
    "PAYMENT_FAILED": {
        "ru": "Платёж не прошёл — обновите способ оплаты или привяжите другую карту.",
        "en": (
            "The payment did not go through. Update your payment method or add a different card."
        ),
        "es": (
            "No se ha podido realizar el pago. Actualiza el método de pago o añade otra tarjeta."
        ),
        "de": (
            "Die Zahlung ist fehlgeschlagen. Aktualisieren Sie die Zahlungsmethode oder "
            "hinterlegen Sie eine andere Karte."
        ),
        "fr": (
            "Le paiement n’a pas abouti. Mettez à jour votre moyen de paiement ou ajoutez "
            "une autre carte."
        ),
        "pt": (
            "O pagamento não foi concluído. Atualize a forma de pagamento ou cadastre outro cartão."
        ),
    },
    "NO_TOKENS": {
        "ru": (
            "Достигнут лимит использования — выберите другой план, "
            "либо увеличьте лимиты на странице оплаты."
        ),
        "en": (
            "You have reached your usage limit. Choose another plan or raise your limits "
            "on the billing page."
        ),
        "es": (
            "Has alcanzado el límite de uso. Elige otro plan o amplía los límites en la página "
            "de pago."
        ),
        "de": (
            "Das Nutzungslimit ist erreicht. Wählen Sie einen anderen Tarif oder erhöhen Sie "
            "die Limits auf der Abrechnungsseite."
        ),
        "fr": (
            "Vous avez atteint votre limite d’utilisation. Choisissez une autre formule ou "
            "augmentez vos limites sur la page de facturation."
        ),
        "pt": (
            "Você atingiu o limite de uso. Escolha outro plano ou aumente os limites na página "
            "de pagamento."
        ),
    },
    "ENTITLEMENT_INACTIVE": {
        "ru": "Подписка неактивна — (пере)привяжите карту или обновите план на странице оплаты.",
        "en": (
            "Your subscription is inactive. Link a card again or update your plan on the "
            "billing page."
        ),
        "es": (
            "Tu suscripción no está activa. Vuelve a vincular una tarjeta o actualiza el plan "
            "en la página de pago."
        ),
        "de": (
            "Ihr Abonnement ist nicht aktiv. Hinterlegen Sie erneut eine Karte oder "
            "aktualisieren Sie den Tarif auf der Abrechnungsseite."
        ),
        "fr": (
            "Votre abonnement est inactif. Associez de nouveau une carte ou mettez à jour "
            "votre formule sur la page de facturation."
        ),
        "pt": (
            "Sua assinatura está inativa. Vincule um cartão novamente ou atualize o plano "
            "na página de pagamento."
        ),
    },
    "MISSING_FEATURE": {
        "ru": "Этот ассистент недоступен для текущей подписки.",
        "en": "This assistant is not available on your current subscription.",
        "es": "Este asistente no está disponible con tu suscripción actual.",
        "de": "Dieser Assistent ist in Ihrem aktuellen Abonnement nicht verfügbar.",
        "fr": "Cet assistant n’est pas disponible avec votre abonnement actuel.",
        "pt": "Este assistente não está disponível na sua assinatura atual.",
    },
    "MISSING_PRIVILEGE": {
        "ru": "Эта функция ассистента недоступна для текущей подписки.",
        "en": "This assistant feature is not available on your current subscription.",
        "es": "Esta función del asistente no está disponible con tu suscripción actual.",
        "de": "Diese Funktion des Assistenten ist in Ihrem aktuellen Abonnement nicht verfügbar.",
        "fr": "Cette fonction de l’assistant n’est pas disponible avec votre abonnement actuel.",
        "pt": "Este recurso do assistente não está disponível na sua assinatura atual.",
    },
}

# Общий fallback по языкам, когда причина неизвестна (не BillingExecutionDeniedError или своя
# ветка агента).
DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE: dict[str, str] = {
    "ru": "Доступ к ассистенту недоступен — проверьте подписку.",
    "en": "The assistant is not available. Check your subscription.",
    "es": "El asistente no está disponible. Revisa tu suscripción.",
    "de": "Der Assistent ist nicht verfügbar. Prüfen Sie Ihr Abonnement.",
    "fr": "L’assistant n’est pas disponible. Vérifiez votre abonnement.",
    "pt": "O assistente não está disponível. Verifique sua assinatura.",
}

# Русские тексты по причине — прежний экспорт, оставлен для совместимости. Новый код берёт
# billing_user_message с локалью хода.
BILLING_USER_MESSAGES: dict[BillingDenialReason, str] = {
    reason: texts["ru"] for reason, texts in BILLING_USER_MESSAGES_BY_LOCALE.items()
}

# Русский общий fallback — прежний экспорт, см. DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE.
DEFAULT_BILLING_USER_MESSAGE = DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE["ru"]


def _denial_reason_of(reason_or_err: object) -> str | None:
    if isinstance(reason_or_err, str):
        return reason_or_err
    if isinstance(reason_or_err, BillingExecutionDeniedError):
        return reason_or_err.reason
    return None


def billing_user_message(reason_or_err: object, locale: str = LEGACY_DEFAULT_LOCALE) -> str:
    """Дружелюбный текст по причине ИЛИ по ошибке на языке ``locale``.

    Агенты зовут его и для СВОИХ preflight-веток (напр. ``billing_user_message("NO_TOKENS",
    current_locale())`` для порога токенов), не собирая BillingExecutionDeniedError.
    None/неизвестная причина → общий текст. Без локали — русский, как раньше; язык вне словаря —
    по цепочке фолбэков до ``en``.
    """
    reason = _denial_reason_of(reason_or_err)
    texts = next(
        (v for k, v in BILLING_USER_MESSAGES_BY_LOCALE.items() if k == reason),
        DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE,
    )
    return t(locale, texts)


def friendly_billing_message(err: object, locale: str = LEGACY_DEFAULT_LOCALE) -> str:
    """Безопасный для конечного пользователя текст по причине отказа (без биллинг-внутренностей).

    Тонкая обёртка над billing_user_message — оставлена ради обратной совместимости импортов.
    """
    return billing_user_message(err, locale)
