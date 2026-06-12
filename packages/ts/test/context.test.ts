import { describe, expect, it } from 'vitest'
import {
  BillingExecutionDeniedError,
  BillingFeatureCode,
  BillingPrivilegeCode,
} from '../src'
import {
  InMemoryBillingClient,
  fixtures,
  makeTestContext,
} from '../src/testing'
import type { Claims } from '../src'

const claims: Claims = {
  iss: 'test',
  aud: 'test',
  sub: 'user-1',
  exp: 0,
  iat: 0,
  org_id: 'user-1',
  billing_org_id: 'billing-org-test',
  app_id: 'sp-ai',
}

describe('AgentContext (через testing kit)', () => {
  it('active: preflight проходит, litellmKey из state, usage записывается', async () => {
    const billing = new InMemoryBillingClient({
      runtimeState: fixtures.runtimeState.active({ remainingTotalTokens: 500 }),
    })
    const ctx = await makeTestContext({ claims, billing })

    const state = await ctx.assertExecutionAllowed()
    expect(state.remainingTotalTokens).toBe(500)
    expect(ctx.litellmKey).toBe('sk-test-litellm')
    expect(ctx.billingOrgId).toBe('billing-org-test')

    await ctx.reportUsage({ transactionId: 'task-1', code: 'lift_calculation' })
    expect(billing.sentUsage).toEqual([
      { transactionId: 'task-1', code: 'lift_calculation', properties: {} },
    ])
  })

  it('no_resources: preflight отклоняется', async () => {
    const ctx = await makeTestContext({
      claims,
      runtimeState: fixtures.runtimeState.no_resources(),
    })
    await expect(ctx.assertExecutionAllowed()).rejects.toBeInstanceOf(
      BillingExecutionDeniedError,
    )
  })

  it('feature_allowed: проходит проверку фичи/привилегии', async () => {
    const ctx = await makeTestContext({
      claims,
      runtimeState: fixtures.runtimeState.feature_allowed(
        BillingFeatureCode.ElevatorCalcAgent,
        BillingPrivilegeCode.ElevatorCalcAllowed,
      ),
    })
    const state = await ctx.assertExecutionAllowed({
      feature: BillingFeatureCode.ElevatorCalcAgent,
      privilege: BillingPrivilegeCode.ElevatorCalcAllowed,
    })
    expect(state.entitlementStatus).toBe('active')
  })

  it('feature_denied: отклоняется при требовании привилегии', async () => {
    const ctx = await makeTestContext({
      claims,
      runtimeState: fixtures.runtimeState.feature_denied(
        BillingFeatureCode.ElevatorCalcAgent,
        BillingPrivilegeCode.ElevatorCalcAllowed,
      ),
    })
    await expect(
      ctx.assertExecutionAllowed({
        feature: BillingFeatureCode.ElevatorCalcAgent,
        privilege: BillingPrivilegeCode.ElevatorCalcAllowed,
      }),
    ).rejects.toBeInstanceOf(BillingExecutionDeniedError)
  })
})
