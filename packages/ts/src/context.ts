// AgentContext — высокоуровневый sugar для агентов: verify JWT → billing → preflight/usage.
// Принимает инъекцию verifier/billingClient (шов для тестов).
import { JwksJwtVerifier, MultiIssuerJwtVerifier } from './auth/verifier'
import {
  CompositeVerifier,
  OpaqueTokenVerifier,
  looksLikeJwt,
} from './auth/introspection'
import { extractBearer } from './auth/headers'
import { AuthError } from './auth/errors'
import { createBillingClient } from './billing/client'
import type {
  BillingClient,
  BillingExecutionRequirement,
  BillingRuntimeState,
} from './billing/types'
import type { Claims, IssuerConfig, JwtVerifier, OrgRole } from './auth/types'

/** Порядок ролей для сравнения в assertRole: USER < EDITOR < OWNER. */
const ORG_ROLE_RANK: Record<OrgRole, number> = { USER: 0, EDITOR: 1, OWNER: 2 }

export interface AgentContextSettings {
  auth: {
    /** Single-issuer config (legacy). Ignored when `issuers` is set. */
    issuer?: string
    audience?: string | string[]
    jwksUrl?: string
    /** Multi-issuer config (preferred). Routes by `iss`; e.g. product + widget channel. */
    issuers?: IssuerConfig[]
    /**
     * Долгоживущие opaque API-ключи: их валидирует introspection-эндпоинт billing-microservice.
     * Если задан вместе с issuer(s) — собирается CompositeVerifier (JWT → JWKS, иначе → introspect).
     */
    introspection?: {
      url: string
      appsToken: string
      cacheTtlMs?: number
    }
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

/**
 * JWT-канал: multi-issuer when `issuers` is set, otherwise the legacy single-issuer config
 * (requires issuer + audience + jwksUrl). Returns undefined when no JWT source is configured.
 */
function buildJwtVerifier(
  auth: AgentContextSettings['auth'],
): JwtVerifier | undefined {
  if (auth.issuers?.length) {
    return new MultiIssuerJwtVerifier({
      issuers: auth.issuers,
      leeway: auth.leeway,
    })
  }
  if (auth.jwksUrl && auth.issuer && auth.audience !== undefined) {
    return new JwksJwtVerifier({
      issuer: auth.issuer,
      audience: auth.audience,
      jwksUrl: auth.jwksUrl,
      leeway: auth.leeway,
    })
  }
  return undefined
}

/**
 * Build a verifier from auth settings. Combines the JWT channel (JWKS) and the opaque-key channel
 * (introspection) into a CompositeVerifier when both are configured; returns whichever single one is
 * configured otherwise, or undefined (migration mode handles a missing verifier).
 */
function buildVerifier(
  auth: AgentContextSettings['auth'],
): JwtVerifier | undefined {
  const jwt = buildJwtVerifier(auth)
  const opaque = auth.introspection?.url
    ? new OpaqueTokenVerifier({
        url: auth.introspection.url,
        appsToken: auth.introspection.appsToken,
        cacheTtlMs: auth.introspection.cacheTtlMs,
      })
    : undefined

  if (jwt && opaque) {
    return new CompositeVerifier({ jwt, opaque })
  }
  return jwt ?? opaque
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

    const verifier = overrides.verifier ?? buildVerifier(settings.auth)

    let claims: Claims | undefined
    if (token) {
      if (!verifier) {
        throw new AuthError(
          'AgentContext: no JWT verifier configured (set auth.issuers or auth.issuer+audience+jwksUrl)',
          'config',
        )
      }
      claims = await verifier.verify(token)
    } else if (required) {
      throw new AuthError('AgentContext: missing bearer token')
    }

    // /state форвардит user-JWT (anti-IDOR по billing_org_id). Для opaque API-ключей (не-JWT)
    // форвардим apps-token: billing /state не принимает opaque-ключ, а billingOrgId всё равно
    // берётся из верифицированных claims, поэтому anti-IDOR сохраняется. usage-ingest (/events) —
    // всегда apps-token.
    const forwardToken =
      token && looksLikeJwt(token) ? token : settings.billing.appsAuthToken
    const billing =
      overrides.billingClient ??
      createBillingClient({
        baseUrl: settings.billing.baseUrl,
        authToken: forwardToken ?? '',
        usageIngestToken: settings.billing.appsAuthToken ?? '',
        timeoutMs: settings.billing.timeoutMs,
        runtimeStateCacheTtlMs: settings.billing.runtimeStateCacheTtlMs,
      })

    return new AgentContext({ claims, rawToken: token, billing })
  }

  get billingOrgId(): string | undefined {
    return this.claims?.billing_org_id
  }

  /** Id организации из claims (расцеплён от `sub`; у виджет/service-account может отсутствовать). */
  get orgId(): string | undefined {
    return this.claims?.org_id
  }

  /** Роль в организации; отсутствующий claim трактуется как `USER` (least-privilege). */
  get role(): OrgRole {
    return this.claims?.org_role ?? 'USER'
  }

  /**
   * Гейт по роли для EDITOR+ инструментов агента. Бросает `AuthError('forbidden_role')`
   * (семантика 403), если роль ниже требуемой. Порядок: USER < EDITOR < OWNER.
   */
  assertRole(min: OrgRole): void {
    if (ORG_ROLE_RANK[this.role] < ORG_ROLE_RANK[min]) {
      throw new AuthError(
        `AgentContext: недостаточно прав (требуется ${min}, есть ${this.role})`,
        'forbidden_role',
      )
    }
  }

  /** Ключ LLM-шлюза из последнего полученного runtime state (preflight). */
  get llmKey(): string | null | undefined {
    return this.cachedState?.llmKey
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
