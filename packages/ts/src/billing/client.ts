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
  const runtimeStateCache = new LRUCache<string, BillingRuntimeState>({
    max: 10_000,
    ttl: Math.max(runtimeStateCacheTtlMs, 1),
    fetchMethod: async (billingOrgId) =>
      fetchRuntimeStateByBillingOrgId(billingOrgId),
  })

  async function fetchRuntimeStateByBillingOrgId(
    billingOrgId: string,
  ): Promise<BillingRuntimeState> {
    const response = await fetchImpl(
      `${baseUrl}/api/v1/billing/customers/by-billing-org/${encodeURIComponent(billingOrgId)}/state`,
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
      `Billing state request failed for billingOrgId=${billingOrgId}`,
    )

    return (await response.json()) as BillingRuntimeState
  }

  async function getRuntimeStateByBillingOrgId(
    billingOrgId: string,
  ): Promise<BillingRuntimeState> {
    const state = await runtimeStateCache.fetch(billingOrgId)

    if (!state) {
      throw new Error(
        `Billing state response was empty for billingOrgId=${billingOrgId}`,
      )
    }

    if (runtimeStateCacheTtlMs === 0) {
      runtimeStateCache.delete(billingOrgId)
    }

    return state
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
