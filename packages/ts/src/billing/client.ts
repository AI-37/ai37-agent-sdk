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
  BillingRuntimeStateOptions,
  BillingRuntimeSubject,
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

// Ключ кэша state: маршрут, id и sub пользователя (`null` — запрос без subject).
type RuntimeStateCacheKey = [RuntimeStateRoute, string, string | null]

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
  // Один кэш на оба способа адресации и на всех пользователей: ключ — JSON `[маршрут, id, subject]`.
  // State по billingOrgId и по orgId не подменяют друг друга, даже если строки id совпали, а два
  // пользователя одной организации не получают роль и группы друг друга. JSON, а не склейка через
  // разделитель: в id и sub может оказаться любой символ.
  const runtimeStateCache = new LRUCache<string, BillingRuntimeState>({
    max: 10_000,
    ttl: Math.max(runtimeStateCacheTtlMs, 1),
    fetchMethod: async (cacheKey) => {
      const [route, id, subject] = JSON.parse(cacheKey) as RuntimeStateCacheKey
      return fetchRuntimeState(route, id, subject)
    },
  })

  async function fetchRuntimeState(
    route: RuntimeStateRoute,
    id: string,
    subject: string | null,
  ): Promise<BillingRuntimeState> {
    const query = subject ? `?subject=${encodeURIComponent(subject)}` : ''
    const response = await fetchImpl(
      `${baseUrl}/api/v1/billing/customers/${route}/${encodeURIComponent(id)}/state${query}`,
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

    return parseRuntimeState(await response.json())
  }

  async function getCachedRuntimeState(
    route: RuntimeStateRoute,
    id: string,
    options?: BillingRuntimeStateOptions,
  ): Promise<BillingRuntimeState> {
    const key: RuntimeStateCacheKey = [route, id, options?.subject || null]
    const cacheKey = JSON.stringify(key)
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
    options?: BillingRuntimeStateOptions,
  ): Promise<BillingRuntimeState> {
    return getCachedRuntimeState('by-billing-org', billingOrgId, options)
  }

  async function getRuntimeStateByOrgId(
    orgId: string,
    options?: BillingRuntimeStateOptions,
  ): Promise<BillingRuntimeState> {
    return getCachedRuntimeState('by-org', orgId, options)
  }

  async function assertExecutionAllowed(
    billingOrgId: string,
    requirement?: BillingExecutionRequirement,
    options?: BillingRuntimeStateOptions,
  ): Promise<BillingRuntimeState> {
    const state = await getRuntimeStateByBillingOrgId(billingOrgId, options)
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

// Блок subject в плане описан в snake_case (`user_uuid`, `group_ids`), остальной state billing
// отдаёт в camelCase. Принимаем оба написания и приводим к camelCase, чтобы клиент не зависел
// от того, как сервер в итоге сериализует блок.
function parseRuntimeState(raw: unknown): BillingRuntimeState {
  const state = raw as BillingRuntimeState & { subject?: unknown }
  if (state.subject === undefined || state.subject === null) {
    const { subject: _absent, ...rest } = state
    return rest
  }
  return { ...state, subject: parseRuntimeSubject(state.subject) }
}

function parseRuntimeSubject(raw: unknown): BillingRuntimeSubject {
  const block = raw as Record<string, unknown>
  const groupIds = block.groupIds ?? block.group_ids
  return {
    userUuid: String(block.userUuid ?? block.user_uuid ?? ''),
    role: (block.role ?? null) as BillingRuntimeSubject['role'],
    groupIds: Array.isArray(groupIds) ? groupIds.map(String) : [],
    member: block.member === true,
  }
}
