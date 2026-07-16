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
 * Безопасный для конечного пользователя текст по причине отказа (не раскрывает биллинг-внутренности).
 * Агенты показывают его в чате, а полную диагностику пишут в логи/трейс. `err` — любое исключение;
 * причина берётся из BillingExecutionDeniedError.reason, иначе — общий fallback.
 */
export function friendlyBillingMessage(err: unknown): string {
  const reason =
    err instanceof BillingExecutionDeniedError ? err.reason : undefined
  switch (reason) {
    case 'NO_TOKENS':
      return 'Достигнут лимит использования — обратитесь к владельцу.'
    case 'ENTITLEMENT_INACTIVE':
      return 'Подписка неактивна — обратитесь к владельцу.'
    case 'MISSING_FEATURE':
    case 'MISSING_PRIVILEGE':
      return 'Этот ассистент недоступен для текущей подписки.'
    default:
      return 'Доступ к ассистенту недоступен — проверьте подписку.'
  }
}
