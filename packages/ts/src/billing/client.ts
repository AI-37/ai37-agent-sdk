// billing-клиент: runtime state + metered usage.
// runtime state несёт llmKey (см. types.ts / contract).
import { LRUCache } from 'lru-cache'
import { hasRequiredAccess } from './access'
import { BillingExecutionDeniedError } from './errors'
import {
  ensureOk,
  normalizeBillingBaseUrl,
  resolveFetch,
  validateOptions,
} from './http'
import type {
  BillingClient,
  BillingClientOptions,
  BillingExecutionRequirement,
  BillingRuntimeState,
  BillingUsageEventInput,
} from './types'

// hasRequiredAccess переехал в ./access (чтобы errors.ts мог звать explainDenial без цикла);
// ре-экспортируем отсюда ради обратной совместимости прежних импортов.
export { hasRequiredAccess } from './access'

// Маршруты state в billing: по аккаунту биллинга (агенты, из JWT) и по организации (сервисы, у
// которых есть только org_id, например DS для пула проекта). Продукт в обоих — из токена.
type RuntimeStateRoute = 'by-billing-org' | 'by-org'

const RUNTIME_STATE_ID_LABEL: Record<RuntimeStateRoute, string> = {
  'by-billing-org': 'billingOrgId',
  'by-org': 'orgId',
}

export function createBillingClient(
  options: BillingClientOptions,
): BillingClient {
  validateOptions(options)

  const baseUrl = normalizeBillingBaseUrl(options.baseUrl)
  // /state — под authToken (форвард user-JWT, anti-IDOR по billing_org_id);
  // usage-ingest — под apps-token (этот эндпоинт user-JWT не принимает).
  const authToken = options.authToken
  const usageIngestToken = options.usageIngestToken
  const timeoutMs = options.timeoutMs ?? 5000
  const runtimeStateCacheTtlMs = options.runtimeStateCacheTtlMs ?? 5000
  const fetchImpl = resolveFetch(options.fetch)
  // Один кэш на оба способа адресации: ключ `<маршрут>:<id>`, поэтому state по billingOrgId и по
  // orgId не подменяют друг друга, даже если строки id совпали.
  const runtimeStateCache = new LRUCache<string, BillingRuntimeState>({
    max: 10_000,
    ttl: Math.max(runtimeStateCacheTtlMs, 1),
    fetchMethod: async (cacheKey) => {
      const separator = cacheKey.indexOf(':')
      return fetchRuntimeState(
        cacheKey.slice(0, separator) as RuntimeStateRoute,
        cacheKey.slice(separator + 1),
      )
    },
  })

  async function fetchRuntimeState(
    route: RuntimeStateRoute,
    id: string,
  ): Promise<BillingRuntimeState> {
    const response = await fetchImpl(
      `${baseUrl}/api/v1/billing/customers/${route}/${encodeURIComponent(id)}/state`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    )

    await ensureOk(
      response,
      `Billing state request failed for ${RUNTIME_STATE_ID_LABEL[route]}=${id}`,
    )

    return (await response.json()) as BillingRuntimeState
  }

  async function getCachedRuntimeState(
    route: RuntimeStateRoute,
    id: string,
  ): Promise<BillingRuntimeState> {
    const cacheKey = `${route}:${id}`
    const state = await runtimeStateCache.fetch(cacheKey)

    if (!state) {
      throw new Error(
        `Billing state response was empty for ${RUNTIME_STATE_ID_LABEL[route]}=${id}`,
      )
    }

    if (runtimeStateCacheTtlMs === 0) {
      runtimeStateCache.delete(cacheKey)
    }

    return state
  }

  async function getRuntimeStateByBillingOrgId(
    billingOrgId: string,
  ): Promise<BillingRuntimeState> {
    return getCachedRuntimeState('by-billing-org', billingOrgId)
  }

  async function getRuntimeStateByOrgId(
    orgId: string,
  ): Promise<BillingRuntimeState> {
    return getCachedRuntimeState('by-org', orgId)
  }

  async function assertExecutionAllowed(
    billingOrgId: string,
    requirement?: BillingExecutionRequirement,
  ): Promise<BillingRuntimeState> {
    const state = await getRuntimeStateByBillingOrgId(billingOrgId)
    if (
      state.entitlementStatus !== 'active' ||
      state.remainingTotalTokens <= 0 ||
      !hasRequiredAccess(state, requirement)
    ) {
      throw new BillingExecutionDeniedError(state, requirement)
    }

    return state
  }

  async function sendUsageEvent(event: BillingUsageEventInput): Promise<void> {
    const payload = buildUsageEventPayload(event)
    const response = await fetchImpl(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${usageIngestToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })

    await ensureOk(response, 'Billing usage event rejected')
  }

  return {
    getRuntimeStateByBillingOrgId,
    getRuntimeStateByOrgId,
    assertExecutionAllowed,
    sendUsageEvent,
  }
}

/** @deprecated alias — используйте createBillingClient. */
export const createBillingAppsClient = createBillingClient

function buildUsageEventPayload(event: BillingUsageEventInput) {
  return {
    event: {
      transaction_id: event.transactionId,
      external_customer_id: event.billingRuntimeState.orgId,
      code: event.code,
      timestamp: event.timestamp ?? Math.floor(Date.now() / 1000),
      properties: event.properties ?? {},
    },
  }
}
