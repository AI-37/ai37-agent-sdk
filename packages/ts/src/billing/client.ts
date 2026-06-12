// Перенос из @ai37/billing-apps-client (src/client.ts). Логика идентична; runtime state
// дополнительно несёт litellmKey (см. types.ts / contract).
import { LRUCache } from 'lru-cache'
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
  BillingRuntimePrivilege,
  BillingRuntimeState,
  BillingUsageEventInput,
} from './types'

export function createBillingClient(
  options: BillingClientOptions,
): BillingClient {
  validateOptions(options)

  const baseUrl = normalizeBillingBaseUrl(options.baseUrl)
  const authToken = options.authToken
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
      throw new BillingExecutionDeniedError(state)
    }

    return state
  }

  async function sendUsageEvent(event: BillingUsageEventInput): Promise<void> {
    const payload = buildUsageEventPayload(event)
    const response = await fetchImpl(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
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

/** @deprecated alias — используйте createBillingClient. Сохранён для совместимости с @ai37/billing-apps-client. */
export const createBillingAppsClient = createBillingClient

/** Чистая проверка прав по runtime state. Переиспользуется in-memory клиентом в testing kit. */
export function hasRequiredAccess(
  state: BillingRuntimeState,
  requirement?: BillingExecutionRequirement,
): boolean {
  if (!requirement?.feature && !requirement?.privilege) {
    return true
  }

  const matchingFeatures = requirement?.feature
    ? state.features.filter((feature) => feature.code === requirement.feature)
    : state.features

  if (matchingFeatures.length === 0) {
    return false
  }

  if (!requirement?.privilege) {
    return true
  }

  return matchingFeatures.some((feature) =>
    feature.privileges.some(
      (privilege) =>
        privilege.code === requirement.privilege &&
        isPrivilegeAccessible(privilege),
    ),
  )
}

function isPrivilegeAccessible(privilege: BillingRuntimePrivilege): boolean {
  if (privilege.valueType === 'boolean') {
    return privilege.value === true
  }

  if (privilege.valueType === 'integer') {
    return typeof privilege.value === 'number'
  }

  if (privilege.valueType === 'string' || privilege.valueType === 'select') {
    return typeof privilege.value === 'string' && privilege.value.length > 0
  }

  return false
}

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
