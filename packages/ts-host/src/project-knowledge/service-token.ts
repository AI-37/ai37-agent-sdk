import { createHash } from 'node:crypto'

/**
 * Служебный токен `client_credentials` для фоновых задач, у которых нет пользователя: отчёт по
 * расписанию грузится в пул проекта DS от имени клиента Authentik (план project-knowledge-bridge,
 * срез 2). Это не OIDC-логин и не обмен токена пользователя: у клиента своя идентичность, а права
 * ему задаёт политика DS.
 *
 * Токен живёт в памяти процесса до истечения с запасом, параллельные вызовы ждут один запрос.
 */

export interface ServiceTokenOptions {
  /** Issuer провайдера Authentik (`https://auth…/application/o/<slug>/`): из него discovery. */
  issuer: string
  clientId: string
  clientSecret: string
  /** scope через пробел, если провайдеру он нужен. */
  scope?: string
  fetchImpl?: typeof fetch
  /** Таймаут каждого запроса, мс (по умолчанию 15 000). */
  timeoutMs?: number
}

export type ServiceTokenErrorCode =
  /** discovery не ответил или в нём нет `token_endpoint`. */
  | 'discovery_failed'
  /** Провайдер отказал (неверный клиент или секрет, grant не разрешён). */
  | 'token_rejected'
  /** В ответе нет `access_token`. */
  | 'invalid_response'
  | 'network_error'

/** Ошибка получения токена. Секрет и тело ответа в текст не попадают. */
export class ServiceTokenError extends Error {
  constructor(
    readonly code: ServiceTokenErrorCode,
    readonly status?: number,
  ) {
    super(`serviceToken: ${code}${status ? ` (HTTP ${status})` : ''}`)
    this.name = 'ServiceTokenError'
  }
}

/** Без `expires_in` провайдер ничего не обещает: держим токен пять минут. */
const DEFAULT_TTL_SECONDS = 300
/** Запас до истечения: токен не должен истечь в пути к DS. */
const MAX_MARGIN_SECONDS = 60

interface CachedToken {
  token: string
  /** Момент, после которого берём новый токен (мс эпохи), уже с запасом. */
  refreshAt: number
}

const tokens = new Map<string, CachedToken>()
const pending = new Map<string, Promise<CachedToken>>()
const tokenEndpoints = new Map<string, Promise<string>>()

/**
 * Access token клиента. Повторный вызов до истечения сети не трогает; после истечения (за минуту
 * до него) берётся новый.
 *
 * ```ts
 * const bearer = await serviceToken({
 *   issuer: process.env.OIDC_ISSUER!,
 *   clientId: process.env.SERVICE_CLIENT_ID!,
 *   clientSecret: process.env.SERVICE_CLIENT_SECRET!,
 * })
 * ```
 */
export async function serviceToken(opts: ServiceTokenOptions): Promise<string> {
  const key = cacheKey(opts)
  const cached = tokens.get(key)
  if (cached && Date.now() < cached.refreshAt) return cached.token
  let inFlight = pending.get(key)
  if (!inFlight) {
    inFlight = requestToken(opts).finally(() => pending.delete(key))
    pending.set(key, inFlight)
  }
  const fresh = await inFlight
  tokens.set(key, fresh)
  return fresh.token
}

/** Секрет в ключе хешем: сменился секрет — нужен новый токен, а сам секрет в памяти не копится. */
function cacheKey(opts: ServiceTokenOptions): string {
  const secret = createHash('sha256').update(opts.clientSecret).digest('hex')
  return [normalizeIssuer(opts.issuer), opts.clientId, opts.scope ?? '', secret].join('\n')
}

async function requestToken(opts: ServiceTokenOptions): Promise<CachedToken> {
  const endpoint = await tokenEndpoint(opts)
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  })
  if (opts.scope) form.set('scope', opts.scope)
  const res = await send(opts, endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  })
  if (!res.ok) throw new ServiceTokenError('token_rejected', res.status)
  const body = (await res.json().catch(() => undefined)) as
    { access_token?: unknown; expires_in?: unknown } | undefined
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new ServiceTokenError('invalid_response', res.status)
  }
  const ttl = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : null
  return { token: body.access_token, refreshAt: Date.now() + refreshAfterSeconds(ttl) * 1000 }
}

/** Короткоживущему токену минута запаса велика: тогда запас — половина срока. */
function refreshAfterSeconds(ttl: number | null): number {
  const lifetime = ttl ?? DEFAULT_TTL_SECONDS
  return lifetime - Math.min(MAX_MARGIN_SECONDS, lifetime / 2)
}

/** token_endpoint из discovery issuer'а; удачный ответ запоминается на весь процесс. */
function tokenEndpoint(opts: ServiceTokenOptions): Promise<string> {
  const issuer = normalizeIssuer(opts.issuer)
  let endpoint = tokenEndpoints.get(issuer)
  if (!endpoint) {
    endpoint = discover(opts, issuer)
    tokenEndpoints.set(issuer, endpoint)
    endpoint.catch(() => tokenEndpoints.delete(issuer))
  }
  return endpoint
}

async function discover(opts: ServiceTokenOptions, issuer: string): Promise<string> {
  const res = await send(opts, `${issuer}/.well-known/openid-configuration`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new ServiceTokenError('discovery_failed', res.status)
  const doc = (await res.json().catch(() => undefined)) as { token_endpoint?: unknown } | undefined
  if (typeof doc?.token_endpoint !== 'string' || !doc.token_endpoint) {
    throw new ServiceTokenError('discovery_failed', res.status)
  }
  return doc.token_endpoint
}

async function send(opts: ServiceTokenOptions, url: string, init: RequestInit): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) })
  } catch {
    throw new ServiceTokenError('network_error')
  }
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '')
}
