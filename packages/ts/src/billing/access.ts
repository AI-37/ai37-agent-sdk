// billing: чистые проверки прав доступа + разбор причины отказа (без сети, без ошибок/циклов).
import type {
  BillingExecutionRequirement,
  BillingRuntimePrivilege,
  BillingRuntimeState,
} from './types'

/** Конкретная причина отказа `assertExecutionAllowed` — машиночитаемая, для логов и UI-маппинга. */
export type BillingDenialReason =
  | 'ENTITLEMENT_INACTIVE'
  | 'NO_TOKENS'
  | 'MISSING_FEATURE'
  | 'MISSING_PRIVILEGE'

export function isPrivilegeAccessible(privilege: BillingRuntimePrivilege): boolean {
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

/**
 * Определяет КОНКРЕТНУЮ причину отказа доступа (для информативной ошибки). Проверяет те же три
 * условия, что `assertExecutionAllowed`, и различает отсутствие фичи vs непредоставленную привилегию.
 * Возвращает `null`, если отказа нет (доступ разрешён).
 */
export function explainDenial(
  state: BillingRuntimeState,
  requirement?: BillingExecutionRequirement,
): { reason: BillingDenialReason; detail: string } | null {
  if (state.entitlementStatus !== 'active') {
    return {
      reason: 'ENTITLEMENT_INACTIVE',
      detail:
        `entitlement_status=${state.entitlementStatus} ` +
        `(plan=${state.currentPlanCode ?? '—'}, subscription_status=${state.currentSubscriptionStatus ?? '—'})`,
    }
  }

  if (state.remainingTotalTokens <= 0) {
    return {
      reason: 'NO_TOKENS',
      detail: `remaining_total_tokens=${state.remainingTotalTokens}`,
    }
  }

  // entitlement активен и токены есть → отказ может быть только по требуемому доступу.
  if (requirement?.feature && !state.features.some((f) => f.code === requirement.feature)) {
    const granted = state.features.map((f) => f.code).join(', ')
    return {
      reason: 'MISSING_FEATURE',
      detail: `required feature=${requirement.feature} not granted (granted: [${granted}])`,
    }
  }

  if (!hasRequiredAccess(state, requirement)) {
    return {
      reason: 'MISSING_PRIVILEGE',
      detail:
        `feature=${requirement?.feature ?? '*'} present but ` +
        `privilege=${requirement?.privilege ?? '*'} not granted or not accessible`,
    }
  }

  return null
}
