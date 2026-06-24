// billing-типы (+ поле llmKey, v1.2).
// Источник истины по форме runtime state — contract/billing-runtime-state.schema.json.
import type { BillingFeatureCode, BillingPrivilegeCode } from '../codes'

export type BillingRuntimePrivilegeValueType =
  | 'integer'
  | 'boolean'
  | 'string'
  | 'select'

export interface BillingRuntimePrivilegeConfig {
  selectOptions?: string[]
}

export interface BillingRuntimePrivilege {
  code: string
  name?: string | null
  value?: number | boolean | string | null
  valueType: BillingRuntimePrivilegeValueType
  config: BillingRuntimePrivilegeConfig
}

export interface BillingRuntimeFeature {
  code: string
  name?: string | null
  description?: string | null
  privileges: BillingRuntimePrivilege[]
}

export interface BillingRuntimeState {
  orgId: string
  billingOrgId: string
  licensedExternalSubscriptionId?: string | null
  meteredExternalSubscriptionId?: string | null
  currentPlanCode?: string | null
  currentSubscriptionStatus?: string | null
  entitlementStatus: string
  remainingTotalTokens: number
  features: BillingRuntimeFeature[]
  /** Виртуальный ключ LLM-шлюза (v1.2+). Секрет — не логировать. */
  llmKey?: string | null
  trialEndsAt?: string | null
  snapshotUpdatedAt?: string
  snapshotVersion?: number
  stale: boolean
}

export interface BillingUsageEventInput {
  transactionId: string
  billingRuntimeState: BillingRuntimeState
  code: string
  timestamp?: number
  properties?: Record<string, unknown>
}

export type BillingFetch = typeof fetch

export interface BillingClientOptions {
  baseUrl: string
  /**
   * Токен для runtime-state запросов (`GET /state`). Сюда форвардится user-JWT —
   * billing валидирует его dual-mode и делает anti-IDOR по claim `billing_org_id`.
   */
  authToken: string
  /**
   * Токен для usage-ingest (`POST /api/v1/events`). Этот эндпоинт принимает
   * ТОЛЬКО apps-token (server-to-server), не user-JWT, — поэтому токен задаётся
   * отдельно от {@link authToken} и обязателен.
   */
  usageIngestToken: string
  timeoutMs?: number
  runtimeStateCacheTtlMs?: number
  fetch?: BillingFetch
}

/** @deprecated alias — используйте BillingClientOptions */
export type BillingAppsClientOptions = BillingClientOptions

export interface BillingExecutionRequirement {
  feature?: BillingFeatureCode
  privilege?: BillingPrivilegeCode
}

export interface BillingClient {
  getRuntimeStateByBillingOrgId(
    billingOrgId: string,
  ): Promise<BillingRuntimeState>
  assertExecutionAllowed(
    billingOrgId: string,
    requirement?: BillingExecutionRequirement,
  ): Promise<BillingRuntimeState>
  sendUsageEvent(event: BillingUsageEventInput): Promise<void>
}

/** @deprecated alias — используйте BillingClient */
export type BillingAppsClient = BillingClient
