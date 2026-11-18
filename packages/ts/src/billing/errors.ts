// billing: ошибки.
import { explainDenial, type BillingDenialReason } from './access'
import type { BillingExecutionRequirement, BillingRuntimeState } from './types'
import { LEGACY_DEFAULT_LOCALE, t, type LocaleDict } from '../locale'

export class BillingConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BillingConfigurationError'
  }
}

export class BillingRequestError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'BillingRequestError'
    this.status = status
    this.body = body
  }
}

export class BillingExecutionDeniedError extends Error {
  readonly state: BillingRuntimeState
  /** Требование доступа, при котором произошёл отказ (feature/privilege). */
  readonly requirement?: BillingExecutionRequirement
  /** Машиночитаемая причина — для логов и UI-маппинга (см. friendlyBillingMessage). */
  readonly reason: BillingDenialReason

  constructor(
    state: BillingRuntimeState,
    requirement?: BillingExecutionRequirement,
  ) {
    // Называем РЕАЛЬНУЮ причину (не всегда «нет ресурсов»): неактивный entitlement, нет токенов,
    // отсутствующая фича или непредоставленная привилегия — с деталями для отладки.
    const denial = explainDenial(state, requirement) ?? {
      reason: 'NO_TOKENS' as const,
      detail: `remaining_total_tokens=${state.remainingTotalTokens}`,
    }
    super(`BILLING_DENIED[${denial.reason}]: ${denial.detail}`)
    this.name = 'BillingExecutionDeniedError'
    this.state = state
    this.requirement = requirement
    this.reason = denial.reason
  }
}

/**
 * Единый источник текстов биллинг-ошибок для чата, по языкам. Агенты НЕ конструируют строки сами —
 * берут отсюда через {@link billingUserMessage}, а полную диагностику пишут в логи/трейс. Ключ —
 * машиночитаемая причина отказа. Русский — источник истины, остальные языки переводятся с него.
 */
export const BILLING_USER_MESSAGES_BY_LOCALE: Record<BillingDenialReason, LocaleDict<string>> = {
  PAYMENT_FAILED: {
    ru: 'Платёж не прошёл — обновите способ оплаты или привяжите другую карту.',
    en: 'The payment did not go through. Update your payment method or add a different card.',
    es: 'No se ha podido realizar el pago. Actualiza el método de pago o añade otra tarjeta.',
    de: 'Die Zahlung ist fehlgeschlagen. Aktualisieren Sie die Zahlungsmethode oder hinterlegen Sie eine andere Karte.',
    fr: 'Le paiement n’a pas abouti. Mettez à jour votre moyen de paiement ou ajoutez une autre carte.',
    pt: 'O pagamento não foi concluído. Atualize a forma de pagamento ou cadastre outro cartão.',
  },
  NO_TOKENS: {
    ru: 'Достигнут лимит использования — выберите другой план, либо увеличьте лимиты на странице оплаты.',
    en: 'You have reached your usage limit. Choose another plan or raise your limits on the billing page.',
    es: 'Has alcanzado el límite de uso. Elige otro plan o amplía los límites en la página de pago.',
    de: 'Das Nutzungslimit ist erreicht. Wählen Sie einen anderen Tarif oder erhöhen Sie die Limits auf der Abrechnungsseite.',
    fr: 'Vous avez atteint votre limite d’utilisation. Choisissez une autre formule ou augmentez vos limites sur la page de facturation.',
    pt: 'Você atingiu o limite de uso. Escolha outro plano ou aumente os limites na página de pagamento.',
  },
  ENTITLEMENT_INACTIVE: {
    ru: 'Подписка неактивна — (пере)привяжите карту или обновите план на странице оплаты.',
    en: 'Your subscription is inactive. Link a card again or update your plan on the billing page.',
    es: 'Tu suscripción no está activa. Vuelve a vincular una tarjeta o actualiza el plan en la página de pago.',
    de: 'Ihr Abonnement ist nicht aktiv. Hinterlegen Sie erneut eine Karte oder aktualisieren Sie den Tarif auf der Abrechnungsseite.',
    fr: 'Votre abonnement est inactif. Associez de nouveau une carte ou mettez à jour votre formule sur la page de facturation.',
    pt: 'Sua assinatura está inativa. Vincule um cartão novamente ou atualize o plano na página de pagamento.',
  },
  MISSING_FEATURE: {
    ru: 'Этот ассистент недоступен для текущей подписки.',
    en: 'This assistant is not available on your current subscription.',
    es: 'Este asistente no está disponible con tu suscripción actual.',
    de: 'Dieser Assistent ist in Ihrem aktuellen Abonnement nicht verfügbar.',
    fr: 'Cet assistant n’est pas disponible avec votre abonnement actuel.',
    pt: 'Este assistente não está disponível na sua assinatura atual.',
  },
  MISSING_PRIVILEGE: {
    ru: 'Эта функция ассистента недоступна для текущей подписки.',
    en: 'This assistant feature is not available on your current subscription.',
    es: 'Esta función del asistente no está disponible con tu suscripción actual.',
    de: 'Diese Funktion des Assistenten ist in Ihrem aktuellen Abonnement nicht verfügbar.',
    fr: 'Cette fonction de l’assistant n’est pas disponible avec votre abonnement actuel.',
    pt: 'Este recurso do assistente não está disponível na sua assinatura atual.',
  },
}

/** Общий fallback по языкам, когда причина неизвестна (не BillingExecutionDeniedError или своя ветка агента). */
export const DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE: LocaleDict<string> = {
  ru: 'Доступ к ассистенту недоступен — проверьте подписку.',
  en: 'The assistant is not available. Check your subscription.',
  es: 'El asistente no está disponible. Revisa tu suscripción.',
  de: 'Der Assistent ist nicht verfügbar. Prüfen Sie Ihr Abonnement.',
  fr: 'L’assistant n’est pas disponible. Vérifiez votre abonnement.',
  pt: 'O assistente não está disponível. Verifique sua assinatura.',
}

/**
 * Русские тексты по причине — прежний экспорт, оставлен для совместимости. Новый код берёт
 * {@link billingUserMessage} с локалью хода.
 */
export const BILLING_USER_MESSAGES: Record<BillingDenialReason, string> = Object.fromEntries(
  Object.entries(BILLING_USER_MESSAGES_BY_LOCALE).map(([reason, dict]) => [reason, dict.ru]),
) as Record<BillingDenialReason, string>

/** Русский общий fallback — прежний экспорт, см. {@link DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE}. */
export const DEFAULT_BILLING_USER_MESSAGE = DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE.ru!

function denialReasonOf(reasonOrErr: BillingDenialReason | unknown): string | undefined {
  if (typeof reasonOrErr === 'string') return reasonOrErr
  if (reasonOrErr instanceof BillingExecutionDeniedError) return reasonOrErr.reason
  return undefined
}

/**
 * Дружелюбный текст по причине ИЛИ по ошибке на языке `locale`. Агенты зовут его и для СВОИХ
 * preflight-веток (напр. `billingUserMessage('NO_TOKENS', currentLocale())` для порога токенов), не
 * собирая BillingExecutionDeniedError. `null`/неизвестная причина → общий текст. Без локали — русский,
 * как раньше; язык вне словаря — по цепочке фолбэков до `en`.
 */
export function billingUserMessage(
  reasonOrErr: BillingDenialReason | unknown,
  locale: string = LEGACY_DEFAULT_LOCALE,
): string {
  const reason = denialReasonOf(reasonOrErr)
  const known = reason !== undefined && Object.hasOwn(BILLING_USER_MESSAGES_BY_LOCALE, reason)
  const dict = known
    ? BILLING_USER_MESSAGES_BY_LOCALE[reason as BillingDenialReason]
    : DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE
  return t(locale, dict)
}

/**
 * Безопасный для конечного пользователя текст по причине отказа (не раскрывает биллинг-внутренности).
 * Тонкая обёртка над {@link billingUserMessage} — оставлена ради обратной совместимости импортов.
 */
export function friendlyBillingMessage(
  err: unknown,
  locale: string = LEGACY_DEFAULT_LOCALE,
): string {
  return billingUserMessage(err, locale)
}
