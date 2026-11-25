// Канонические фикстуры BillingRuntimeState для тестов агентов (по contract/).
import type {
  BillingRuntimeFeature,
  BillingRuntimeState,
  BillingRuntimeSubject,
} from '../billing/types'

const BASE: BillingRuntimeState = {
  orgId: 'org-test',
  billingOrgId: 'billing-org-test',
  entitlementStatus: 'active',
  remainingTotalTokens: 1000,
  features: [],
  llmKey: 'sk-test-llm',
  stale: false,
}

function active(
  overrides: Partial<BillingRuntimeState> = {},
): BillingRuntimeState {
  return { ...BASE, ...overrides }
}

function noResources(
  overrides: Partial<BillingRuntimeState> = {},
): BillingRuntimeState {
  return {
    ...BASE,
    entitlementStatus: 'no_resources',
    remainingTotalTokens: 0,
    ...overrides,
  }
}

function trial(
  overrides: Partial<BillingRuntimeState> = {},
): BillingRuntimeState {
  return {
    ...BASE,
    currentSubscriptionStatus: 'trialing',
    trialEndsAt: '2030-01-01T00:00:00Z',
    ...overrides,
  }
}

function featureGrant(
  feature: string,
  privilege: string,
  value: boolean,
): BillingRuntimeFeature {
  return {
    code: feature,
    privileges: [{ code: privilege, value, valueType: 'boolean', config: {} }],
  }
}

function featureAllowed(
  feature: string,
  privilege: string,
  overrides: Partial<BillingRuntimeState> = {},
): BillingRuntimeState {
  return { ...BASE, features: [featureGrant(feature, privilege, true)], ...overrides }
}

function featureDenied(
  feature: string,
  privilege: string,
  overrides: Partial<BillingRuntimeState> = {},
): BillingRuntimeState {
  return { ...BASE, features: [featureGrant(feature, privilege, false)], ...overrides }
}

// Участник организации для блока subject: по умолчанию EDITOR без групп.
function subjectMember(
  overrides: Partial<BillingRuntimeSubject> = {},
): BillingRuntimeSubject {
  return {
    userUuid: 'user-test',
    role: 'EDITOR',
    groupIds: [],
    member: true,
    ...overrides,
  }
}

// Не участник: так billing отвечает на sub, которого нет среди активных участников.
function subjectNotMember(
  overrides: Partial<BillingRuntimeSubject> = {},
): BillingRuntimeSubject {
  return {
    userUuid: 'user-outsider',
    role: null,
    groupIds: [],
    member: false,
    ...overrides,
  }
}

export const fixtures = {
  runtimeState: {
    active,
    no_resources: noResources,
    trial,
    feature_allowed: featureAllowed,
    feature_denied: featureDenied,
  },
  subject: {
    member: subjectMember,
    not_member: subjectNotMember,
  },
}
