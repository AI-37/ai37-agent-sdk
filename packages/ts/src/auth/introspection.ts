// Верификация непрозрачных (opaque) пользовательских API-ключей через introspection-эндпоинт
// billing-microservice. Ключ — не JWT; identity (sub/org_id/billing_org_id) резолвит billing
// (свой registry + Authentik liveness). Результат кэшируется по sha256(key).
import { createHash } from 'node:crypto'
import { LRUCache } from 'lru-cache'
import { AuthError } from './errors'
import type { Claims, JwtVerifier } from './types'

type FetchLike = typeof fetch

const DEFAULT_TTL_MS = 3_600_000
const DEFAULT_TIMEOUT_MS = 5000

export interface IntrospectionVerifierOptions {
  /** URL introspection-эндпоинта billing-microservice (POST {key} -> {active, claims}). */
  url: string
  /** apps-token для авторизации к эндпоинту (Authorization: Bearer). У агентов он уже есть. */
  appsToken: string
  /** TTL положительного кэша (мс). Дефолт 1ч — безопасно: исполнение гейтит billing runtime state. */
  cacheTtlMs?: number
  /** Таймаут запроса (мс). Дефолт 5000. */
  timeoutMs?: number
  /** Инъекция fetch (для тестов). */
  fetch?: FetchLike
}

interface IntrospectionClaims {
  sub?: unknown
  org_id?: unknown
  billing_org_id?: unknown
  email?: unknown
  name?: unknown
  exp?: unknown
}

interface IntrospectionResponse {
  active?: boolean
  claims?: IntrospectionClaims | null
}

/** Похоже ли на JWT (3 сегмента) — дешёвая эвристика для роутинга JWT vs opaque. */
export function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3
}

function toClaims(raw: IntrospectionClaims): Claims {
  const sub = raw.sub
  const orgId = raw.org_id
  const billingOrgId = raw.billing_org_id
  if (typeof sub !== 'string' || !sub) {
    throw new AuthError('Introspection response missing claim: sub', 'missing_claim')
  }
  if (typeof orgId !== 'string' || !orgId) {
    throw new AuthError('Introspection response missing claim: org_id', 'missing_claim')
  }
  if (typeof billingOrgId !== 'string' || !billingOrgId) {
    throw new AuthError(
      'Introspection response missing claim: billing_org_id',
      'missing_claim',
    )
  }
  // iss/aud/iat синтезируем — downstream использует только sub/org_id/billing_org_id; полнота
  // нужна лишь для соответствия типу Claims.
  const claims: Claims = {
    iss: 'urn:ai37:api-key',
    aud: 'ai37-agents',
    sub,
    org_id: orgId,
    billing_org_id: billingOrgId,
    exp: typeof raw.exp === 'number' ? raw.exp : 0,
    iat: 0,
  }
  if (typeof raw.email === 'string' && raw.email) {
    claims.email = raw.email
  }
  if (typeof raw.name === 'string' && raw.name) {
    claims.name = raw.name
  }
  return claims
}

/**
 * Верификатор opaque-ключей: POST на introspection-эндпоинт billing, кэш положительных ответов по
 * sha256(key). Реализует тот же интерфейс `JwtVerifier`, что и `JwksJwtVerifier`. Отрицательные
 * ответы НЕ кэшируются на стороне SDK (их кэширует сам billing-эндпоинт), чтобы verify() оставался
 * контрактом «вернул Claims или бросил AuthError».
 */
export class OpaqueTokenVerifier implements JwtVerifier {
  private readonly url: string
  private readonly appsToken: string
  private readonly timeoutMs: number
  private readonly fetchImpl: FetchLike
  private readonly cache: LRUCache<string, Claims>

  constructor(options: IntrospectionVerifierOptions) {
    if (!options.url?.trim()) {
      throw new AuthError('OpaqueTokenVerifier: url is required', 'config')
    }
    if (!options.appsToken?.trim()) {
      throw new AuthError('OpaqueTokenVerifier: appsToken is required', 'config')
    }
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (!fetchImpl) {
      throw new AuthError('OpaqueTokenVerifier: fetch is not available', 'config')
    }
    this.url = options.url
    this.appsToken = options.appsToken
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = fetchImpl
    this.cache = new LRUCache<string, Claims>({
      max: 10_000,
      ttl: Math.max(options.cacheTtlMs ?? DEFAULT_TTL_MS, 1),
    })
  }

  async verify(token: string): Promise<Claims> {
    if (!token?.trim()) {
      throw new AuthError('Empty bearer token')
    }
    const keyHash = createHash('sha256').update(token).digest('hex')
    const cached = this.cache.get(keyHash)
    if (cached) {
      return cached
    }
    const claims = await this.introspect(token)
    this.cache.set(keyHash, claims)
    return claims
  }

  private async introspect(token: string): Promise<Claims> {
    let response: Response
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.appsToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key: token }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new AuthError('API key introspection request failed', 'invalid_token', {
        cause,
      })
    }
    if (!response.ok) {
      throw new AuthError(
        `API key introspection failed: status=${response.status}`,
        'invalid_token',
      )
    }
    const body = (await response.json()) as IntrospectionResponse
    if (!body?.active || !body.claims) {
      throw new AuthError('API key is not active', 'invalid_token')
    }
    return toClaims(body.claims)
  }
}

export interface CompositeVerifierOptions {
  /** Верификатор для токенов-JWT (JWKS). */
  jwt?: JwtVerifier
  /** Верификатор для opaque-ключей (introspection). */
  opaque?: JwtVerifier
}

/**
 * Маршрутизирует по форме токена: похоже на JWT → jwt.verify (JWKS), иначе → opaque.verify
 * (introspection). Позволяет одному guard'у принимать и user-JWT, и долгоживущие API-ключи.
 */
export class CompositeVerifier implements JwtVerifier {
  private readonly jwt?: JwtVerifier
  private readonly opaque?: JwtVerifier

  constructor(options: CompositeVerifierOptions) {
    this.jwt = options.jwt
    this.opaque = options.opaque
  }

  async verify(token: string): Promise<Claims> {
    if (!token?.trim()) {
      throw new AuthError('Empty bearer token')
    }
    if (looksLikeJwt(token)) {
      if (!this.jwt) {
        throw new AuthError('CompositeVerifier: no JWT verifier configured', 'config')
      }
      return this.jwt.verify(token)
    }
    if (!this.opaque) {
      throw new AuthError('CompositeVerifier: no opaque verifier configured', 'config')
    }
    return this.opaque.verify(token)
  }
}

export interface CreateCompositeVerifierOptions {
  /** Готовый JWT-верификатор (напр. JwksJwtVerifier / MultiIssuerJwtVerifier). */
  jwt?: JwtVerifier
  /** Опции introspection-канала для opaque-ключей. */
  introspection?: IntrospectionVerifierOptions
}

/**
 * Собирает верификатор из JWT- и/или introspection-канала. Если задан только один — возвращает его
 * напрямую (без обёртки). Удобно консьюмерам, строящим verifier вручную (напр. rag-factory).
 */
export function createCompositeVerifier(
  options: CreateCompositeVerifierOptions,
): JwtVerifier {
  const opaque = options.introspection
    ? new OpaqueTokenVerifier(options.introspection)
    : undefined
  if (!options.jwt && !opaque) {
    throw new AuthError(
      'createCompositeVerifier: at least one of jwt/introspection is required',
      'config',
    )
  }
  if (options.jwt && !opaque) {
    return options.jwt
  }
  if (!options.jwt && opaque) {
    return opaque
  }
  return new CompositeVerifier({ jwt: options.jwt, opaque })
}
