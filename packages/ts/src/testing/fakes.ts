// Инъектируемые фейки для юнит-тестов агентов (Уровень 1 — без сети).
import { BillingExecutionDeniedError } from '../billing/errors'
import { hasRequiredAccess } from '../billing/client'
import type {
  BillingClient,
  BillingExecutionRequirement,
  BillingRuntimeState,
  BillingUsageEventInput,
} from '../billing/types'
import type { Claims, JwtVerifier } from '../auth/types'

/** Верификатор, возвращающий заданные claims без проверки подписи (только для тестов). */
export class FakeJwtVerifier implements JwtVerifier {
  constructor(private readonly claims: Claims) {}
  async verify(_token: string): Promise<Claims> {
    return this.claims
  }
}

export interface SentUsage {
  transactionId: string
  code: string
  properties: Record<string, unknown>
}

/** In-memory billing-клиент: отдаёт фикстуру runtime state, пишет usage в .sentUsage. */
export class InMemoryBillingClient implements BillingClient {
  readonly sentUsage: SentUsage[] = []
  private state: BillingRuntimeState

  constructor(options: { runtimeState: BillingRuntimeState }) {
    this.state = options.runtimeState
  }

  setRuntimeState(state: BillingRuntimeState): void {
    this.state = state
  }

  async getRuntimeStateByBillingOrgId(
    _billingOrgId: string,
  ): Promise<BillingRuntimeState> {
    return this.state
  }

  async assertExecutionAllowed(
    _billingOrgId: string,
    requirement?: BillingExecutionRequirement,
  ): Promise<BillingRuntimeState> {
    const s = this.state
    if (
      s.entitlementStatus !== 'active' ||
      s.remainingTotalTokens <= 0 ||
      !hasRequiredAccess(s, requirement)
    ) {
      throw new BillingExecutionDeniedError(s)
    }
    return s
  }

  async sendUsageEvent(event: BillingUsageEventInput): Promise<void> {
    this.sentUsage.push({
      transactionId: event.transactionId,
      code: event.code,
      properties: event.properties ?? {},
    })
  }
}
