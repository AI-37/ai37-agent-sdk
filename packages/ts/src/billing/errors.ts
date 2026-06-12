// Перенос из @ai37/billing-apps-client (src/errors.ts).
import type { BillingRuntimeState } from './types'

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

  constructor(state: BillingRuntimeState) {
    super(
      `BILLING_NO_RESOURCES: entitlement_status=${state.entitlementStatus}, remaining_total_tokens=${state.remainingTotalTokens}`,
    )
    this.name = 'BillingExecutionDeniedError'
    this.state = state
  }
}
