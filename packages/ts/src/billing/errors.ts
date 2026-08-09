// billing: ошибки.
import { explainDenial, type BillingDenialReason } from './access'
import type { BillingExecutionRequirement, BillingRuntimeState } from './types'

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
 * Единый источник текстов биллинг-ошибок для чата. Агенты НЕ конструируют строки сами — берут отсюда,
 * а полную диагностику пишут в логи/трейс. Ключ — машиночитаемая причина отказа.
 */
export const BILLING_USER_MESSAGES: Record<BillingDenialReason, string> = {
  PAYMENT_FAILED:
    'Платёж не прошёл — обновите способ оплаты или привяжите другую карту.',
  NO_TOKENS:
    'Достигнут лимит использования — выберите другой план, либо увеличьте лимиты на странице оплаты.',
  ENTITLEMENT_INACTIVE:
    'Подписка неактивна — (пере)привяжите карту или обновите план на странице оплаты.',
  MISSING_FEATURE: 'Этот ассистент недоступен для текущей подписки.',
  MISSING_PRIVILEGE: 'Эта функция ассистента недоступна для текущей подписки.',
}

/** Общий fallback, когда причина неизвестна (не BillingExecutionDeniedError или своя ветка агента). */
export const DEFAULT_BILLING_USER_MESSAGE =
  'Доступ к ассистенту недоступен — проверьте подписку.'

/**
 * Дружелюбный текст по причине ИЛИ по ошибке. Агенты зовут его и для СВОИХ preflight-веток
 * (напр. `billingUserMessage('NO_TOKENS')` для порога токенов), не собирая BillingExecutionDeniedError.
 * `null`/неизвестная причина → {@link DEFAULT_BILLING_USER_MESSAGE}.
 */
export function billingUserMessage(
  reasonOrErr: BillingDenialReason | unknown,
): string {
  const reason: BillingDenialReason | undefined =
    typeof reasonOrErr === 'string'
      ? (reasonOrErr as BillingDenialReason)
      : reasonOrErr instanceof BillingExecutionDeniedError
        ? reasonOrErr.reason
        : undefined
  return (
    (reason && BILLING_USER_MESSAGES[reason]) || DEFAULT_BILLING_USER_MESSAGE
  )
}

/**
 * Безопасный для конечного пользователя текст по причине отказа (не раскрывает биллинг-внутренности).
 * Тонкая обёртка над {@link billingUserMessage} — оставлена ради обратной совместимости импортов.
 */
export function friendlyBillingMessage(err: unknown): string {
  return billingUserMessage(err)
}
