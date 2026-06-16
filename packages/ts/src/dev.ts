// Рантайм dev-режим: обход JWT-подписи + фейковый billing-state из JSON-файлов.
// Реализует замороженный контракт (contract/env.md): AI37_AUTH_MODE=insecure-dev /
// AI37_DEV_CLAIMS_FILE / BILLING_MODE=fake / BILLING_STATE_FILE.
//
// ВАЖНО: ВЫКЛЮЧЕНО ПО УМОЛЧАНИЮ — активно только при явных env-флагах, и fail-closed в проде
// (бросает на старте при прод-признаках). Переиспользует тест-швы FakeJwtVerifier /
// InMemoryBillingClient — никакой новой инфраструктуры auth/billing.
import { readFileSync } from 'node:fs'
import { FakeJwtVerifier, InMemoryBillingClient } from './testing/fakes'
import { fixtures } from './testing/fixtures'
import type { AgentContextOverrides } from './context'
import type { Claims } from './auth/types'
import type { BillingRuntimeState } from './billing/types'

export type DevEnv = Record<string, string | undefined>

const AUTH_MODE_INSECURE = 'insecure-dev'
const BILLING_MODE_FAKE = 'fake'

/** Боевой issuer = https и хост не локальный. http/localhost/127.0.0.1/*.local считаем dev. */
function looksProdIssuer(issuer: string): boolean {
  try {
    const url = new URL(issuer)
    if (url.protocol !== 'https:') return false
    const host = url.hostname
    return (
      host !== 'localhost' &&
      host !== '127.0.0.1' &&
      !host.endsWith('.local') &&
      host !== 'host.docker.internal'
    )
  } catch {
    return false
  }
}

/** Возвращает строку-описание первого найденного прод-признака или null. */
function detectProdSignal(env: DevEnv): string | null {
  if (env.NODE_ENV === 'production') return 'NODE_ENV=production'
  const envName = (env.ENV ?? env.APP_ENV ?? '').toLowerCase()
  if (envName === 'prod' || envName === 'production') return `ENV=${envName}`
  const issuer = env.AI37_OIDC_ISSUER ?? (env.AI37_OIDC_ISSUERS ?? '').split(',')[0] ?? ''
  if (issuer && looksProdIssuer(issuer)) return `AI37_OIDC_ISSUER=${issuer}`
  return null
}

function loadClaims(path: string | undefined): Claims {
  if (!path) {
    throw new Error(
      '[ai37-agent-sdk] AI37_AUTH_MODE=insecure-dev требует AI37_DEV_CLAIMS_FILE (путь к JSON с claims)',
    )
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Claims>
  for (const key of ['sub', 'org_id', 'billing_org_id'] as const) {
    if (!parsed[key]) {
      throw new Error(`[ai37-agent-sdk] ${path}: отсутствует обязательный claim "${key}"`)
    }
  }
  return parsed as Claims
}

function loadBillingState(path: string | undefined): BillingRuntimeState {
  if (!path) return fixtures.runtimeState.active()
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BillingRuntimeState>
  for (const key of ['orgId', 'billingOrgId', 'entitlementStatus'] as const) {
    if (parsed[key] === undefined) {
      throw new Error(`[ai37-agent-sdk] ${path}: отсутствует обязательное поле "${key}"`)
    }
  }
  if (typeof parsed.remainingTotalTokens !== 'number') {
    throw new Error(`[ai37-agent-sdk] ${path}: поле "remainingTotalTokens" должно быть числом`)
  }
  // Дефолты для необязательных полей формы (contract/billing-runtime-state.schema.json).
  return { features: [], stale: false, ...parsed } as BillingRuntimeState
}

/**
 * Строит overrides для `AgentContext.fromRequest` по env. В обычном режиме (флаги не выставлены)
 * возвращает `{}` — поведение хоста не меняется. Бросает на старте, если dev-режим включён в проде.
 */
export function buildDevContextOverrides(env: DevEnv = process.env): AgentContextOverrides {
  const insecureAuth = env.AI37_AUTH_MODE === AUTH_MODE_INSECURE
  const fakeBilling = env.BILLING_MODE === BILLING_MODE_FAKE

  if (!insecureAuth && !fakeBilling) return {}

  const prodSignal = detectProdSignal(env)
  if (prodSignal) {
    throw new Error(
      `[ai37-agent-sdk] dev-режим (AI37_AUTH_MODE=insecure-dev / BILLING_MODE=fake) запрещён в ` +
        `проде: обнаружен прод-признак ${prodSignal}. Хост не запущен.`,
    )
  }

  const overrides: AgentContextOverrides = {}

  if (insecureAuth) {
    const claims = loadClaims(env.AI37_DEV_CLAIMS_FILE)
    console.warn(
      `[ai37-agent-sdk] ⚠️ AI37_AUTH_MODE=insecure-dev: JWT-подпись НЕ проверяется, claims из файла ` +
        `(sub=${claims.sub}, billing_org_id=${claims.billing_org_id}). Только для локальной разработки.`,
    )
    overrides.verifier = new FakeJwtVerifier(claims)
  }

  if (fakeBilling) {
    const state = loadBillingState(env.BILLING_STATE_FILE)
    console.warn(
      `[ai37-agent-sdk] ⚠️ BILLING_MODE=fake: billing-сервис НЕ вызывается, runtime state из ` +
        `${env.BILLING_STATE_FILE ?? 'фикстуры active()'} (entitlementStatus=${state.entitlementStatus}). ` +
        `Только для локальной разработки.`,
    )
    overrides.billingClient = new InMemoryBillingClient({ runtimeState: state })
  }

  return overrides
}

/** true, если хоть один dev-флаг выставлен (для логов/диагностики на стороне хоста). */
export function isDevModeRequested(env: DevEnv = process.env): boolean {
  return env.AI37_AUTH_MODE === AUTH_MODE_INSECURE || env.BILLING_MODE === BILLING_MODE_FAKE
}
