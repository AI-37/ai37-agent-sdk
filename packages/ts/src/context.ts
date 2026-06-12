// AgentContext — высокоуровневый sugar для агентов: verify JWT → billing → preflight/usage.
// Принимает инъекцию verifier/billingClient (шов для тестов).
import { JwksJwtVerifier } from './auth/verifier'
import { extractBearer } from './auth/headers'
import { AuthError } from './auth/errors'
import { createBillingClient } from './billing/client'
import type {
  BillingClient,
  BillingExecutionRequirement,
  BillingRuntimeState,
} from './billing/types'
import type { Claims, JwtVerifier } from './auth/types'

export interface AgentContextSettings {
  auth: {
    issuer: string
    audience: string | string[]
    jwksUrl?: string
    /** JWT обязателен (true) или допускается отсутствие на миграции (false). */
    required?: boolean
    leeway?: number
  }
  billing: {
    baseUrl: string
    /** Legacy apps-token (используется, если нет user-JWT). */
    appsAuthToken?: string
    timeoutMs?: number
    runtimeStateCacheTtlMs?: number
  }
}

export interface AgentContextOverrides {
  verifier?: JwtVerifier
  billingClient?: BillingClient
}

export interface ReportUsageInput {
  transactionId: string
  code: string
  properties?: Record<string, unknown>
}

export class AgentContext {
  readonly claims?: Claims
  readonly rawToken?: string
  readonly billing: BillingClient
  private cachedState?: BillingRuntimeState

  private constructor(init: {
    claims?: Claims
    rawToken?: string
    billing: BillingClient
  }) {
    this.claims = init.claims
    this.rawToken = init.rawToken
    this.billing = init.billing
  }

  static async fromRequest(
    headers:
      | Headers
      | Record<string, string | string[] | undefined>
      | undefined,
    settings: AgentContextSettings,
    overrides: AgentContextOverrides = {},
  ): Promise<AgentContext> {
    const token = extractBearer(headers)
    const required = settings.auth.required ?? true

    const verifier =
      overrides.verifier ??
      (settings.auth.jwksUrl
        ? new JwksJwtVerifier({
            issuer: settings.auth.issuer,
            audience: settings.auth.audience,
            jwksUrl: settings.auth.jwksUrl,
            leeway: settings.auth.leeway,
          })
        : undefined)

    let claims: Claims | undefined
    if (token) {
      if (!verifier) {
        throw new AuthError(
          'AgentContext: no JWT verifier configured (set auth.jwksUrl)',
          'config',
        )
      }
      claims = await verifier.verify(token)
    } else if (required) {
      throw new AuthError('AgentContext: missing bearer token')
    }

    const forwardToken = token ?? settings.billing.appsAuthToken
    const billing =
      overrides.billingClient ??
      createBillingClient({
        baseUrl: settings.billing.baseUrl,
        authToken: forwardToken ?? '',
        timeoutMs: settings.billing.timeoutMs,
        runtimeStateCacheTtlMs: settings.billing.runtimeStateCacheTtlMs,
      })

    return new AgentContext({ claims, rawToken: token, billing })
  }

  get billingOrgId(): string | undefined {
    return this.claims?.billing_org_id
  }

  /** litellm_key продукта из последнего полученного runtime state (preflight). */
  get litellmKey(): string | null | undefined {
    return this.cachedState?.litellmKey
  }

  private requireBillingOrgId(): string {
    const id = this.billingOrgId
    if (!id) {
      throw new AuthError(
        'AgentContext: billing_org_id отсутствует (claims не верифицированы?)',
        'missing_claim',
      )
    }
    return id
  }

  async assertExecutionAllowed(
    requirement?: BillingExecutionRequirement,
  ): Promise<BillingRuntimeState> {
    const state = await this.billing.assertExecutionAllowed(
      this.requireBillingOrgId(),
      requirement,
    )
    this.cachedState = state
    return state
  }

  async reportUsage(input: ReportUsageInput): Promise<void> {
    const state =
      this.cachedState ??
      (await this.billing.getRuntimeStateByBillingOrgId(
        this.requireBillingOrgId(),
      ))
    await this.billing.sendUsageEvent({
      transactionId: input.transactionId,
      billingRuntimeState: state,
      code: input.code,
      properties: input.properties,
    })
  }
}
