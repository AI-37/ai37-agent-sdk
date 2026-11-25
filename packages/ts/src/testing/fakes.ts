// Инъектируемые фейки для юнит-тестов агентов (Уровень 1 — без сети).
import { BillingExecutionDeniedError } from '../billing/errors'
import { hasRequiredAccess } from '../billing/client'
import type {
  BillingClient,
  BillingExecutionRequirement,
  BillingRuntimeState,
  BillingRuntimeStateOptions,
  BillingRuntimeSubject,
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

/**
 * In-memory billing-клиент: отдаёт фикстуру runtime state, пишет usage в .sentUsage.
 *
 * С `{ subject }` к state добавляется блок `subject` из `subjects` (по `userUuid`), как это делает
 * billing. Неизвестный пользователь получает `member: false` без групп. Без `{ subject }` state
 * отдаётся как есть.
 */
export class InMemoryBillingClient implements BillingClient {
  readonly sentUsage: SentUsage[] = []
  private state: BillingRuntimeState
  private readonly subjects = new Map<string, BillingRuntimeSubject>()

  constructor(options: {
    runtimeState: BillingRuntimeState
    subjects?: BillingRuntimeSubject[]
  }) {
    this.state = options.runtimeState
    for (const subject of options.subjects ?? []) this.setSubject(subject)
  }

  setRuntimeState(state: BillingRuntimeState): void {
    this.state = state
  }

  /** Задать (или заменить) роль и группы пользователя для запросов с `{ subject }`. */
  setSubject(subject: BillingRuntimeSubject): void {
    this.subjects.set(subject.userUuid, subject)
  }

  async getRuntimeStateByBillingOrgId(
    _billingOrgId: string,
    options?: BillingRuntimeStateOptions,
  ): Promise<BillingRuntimeState> {
    return this.stateFor(options)
  }

  async getRuntimeStateByOrgId(
    _orgId: string,
    options?: BillingRuntimeStateOptions,
  ): Promise<BillingRuntimeState> {
    return this.stateFor(options)
  }

  async assertExecutionAllowed(
    _billingOrgId: string,
    requirement?: BillingExecutionRequirement,
    options?: BillingRuntimeStateOptions,
  ): Promise<BillingRuntimeState> {
    const s = this.stateFor(options)
    if (
      s.entitlementStatus !== 'active' ||
      s.remainingTotalTokens <= 0 ||
      !hasRequiredAccess(s, requirement)
    ) {
      throw new BillingExecutionDeniedError(s, requirement)
    }
    return s
  }

  private stateFor(options?: BillingRuntimeStateOptions): BillingRuntimeState {
    const userUuid = options?.subject
    if (!userUuid) return this.state
    const subject = this.subjects.get(userUuid) ?? {
      userUuid,
      role: null,
      groupIds: [],
      member: false,
    }
    return { ...this.state, subject }
  }

  async sendUsageEvent(event: BillingUsageEventInput): Promise<void> {
    this.sentUsage.push({
      transactionId: event.transactionId,
      code: event.code,
      properties: event.properties ?? {},
    })
  }
}
