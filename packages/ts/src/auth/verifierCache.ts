// Мемоизация JWT-верификатора между запросами: один живой экземпляр на процесс на каждый
// уникальный состав auth-настроек. JWKS-кэш jose живёт в замыкании key-резолвера, поэтому
// долгоживущий верификатор избавляет от похода за JWKS на каждый запрос.
import type { AgentContextSettings } from '../context'
import type { JwtVerifier } from './types'

type AuthConfig = AgentContextSettings['auth']

// Без вытеснения: уникальных auth-конфигов на процесс — единицы; смена настроек в рантайме
// даёт новый ключ, старый экземпляр остаётся мусором пренебрежимого размера.
const cache = new Map<string, JwtVerifier>()

function normalizeAudience(
  audience: string | string[] | undefined,
): string[] | null {
  if (audience === undefined) {
    return null
  }
  if (Array.isArray(audience)) {
    return audience
  }
  return [audience]
}

/**
 * Детерминированный ключ мемоизации из полного состава auth-настроек: issuer,
 * audience (нормализованный список), jwksUrl, весь массив issuers[], introspection
 * (url/appsToken/cacheTtlMs), leeway. `required` на верификатор не влияет и в ключ не входит.
 *
 * Возвращает undefined для несериализуемых конфигов (`jwks`-набор или `keyResolver`-функция
 * в любом элементе issuers[]) — такие собираются заново на каждый вызов: это тестовые и
 * инъекционные пути, в сеть они не ходят, а честно включить функцию в строковый ключ нельзя.
 */
export function verifierCacheKey(auth: AuthConfig): string | undefined {
  for (const cfg of auth.issuers ?? []) {
    if (cfg.jwks !== undefined || cfg.keyResolver !== undefined) {
      return undefined
    }
  }
  return JSON.stringify({
    issuer: auth.issuer ?? null,
    audience: normalizeAudience(auth.audience),
    jwksUrl: auth.jwksUrl ?? null,
    issuers: (auth.issuers ?? []).map((cfg) => ({
      issuer: cfg.issuer,
      audience: normalizeAudience(cfg.audience),
      jwksUrl: cfg.jwksUrl ?? null,
    })),
    introspection: auth.introspection
      ? {
          url: auth.introspection.url,
          appsToken: auth.introspection.appsToken,
          cacheTtlMs: auth.introspection.cacheTtlMs ?? null,
        }
      : null,
    leeway: auth.leeway ?? null,
  })
}

/**
 * Верификатор по составу настроек: хит кэша → прежний живой экземпляр; промах → build +
 * запись. Несериализуемый конфиг (см. verifierCacheKey) → свежая сборка мимо кэша —
 * текущее допеременное поведение. Явный overrides.verifier сюда не попадает — ветка
 * `overrides.verifier ?? ...` в AgentContext.fromRequest стоит выше мемоизации.
 */
export function getOrBuildVerifier(
  auth: AuthConfig,
  build: (auth: AuthConfig) => JwtVerifier | undefined,
): JwtVerifier | undefined {
  const key = verifierCacheKey(auth)
  if (key === undefined) {
    return build(auth)
  }

  const cached = cache.get(key)
  if (cached) {
    return cached
  }

  const built = build(auth)
  if (built) {
    cache.set(key, built)
  }
  return built
}

/** Тестовый шов: сброс кэша между тестами. */
export function clearVerifierCache(): void {
  cache.clear()
}

/** Тестовый шов: размер кэша (проверки «кэш не растёт»). */
export function verifierCacheSize(): number {
  return cache.size
}
