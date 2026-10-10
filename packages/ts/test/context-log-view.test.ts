import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { Claims } from '../src'
import { InMemoryBillingClient, fixtures, makeTestContext } from '../src/testing'

const claims: Claims = {
  iss: 'test',
  aud: 'test',
  sub: 'user-1',
  exp: 0,
  iat: 0,
  org_id: 'org-1',
  billing_org_id: 'billing-org-1',
  org_role: 'OWNER',
  email: 'person@example.test',
  app_id: 'sp-ai',
}

async function contextWithLlmKey() {
  const billing = new InMemoryBillingClient({ runtimeState: fixtures.runtimeState.active() })
  const ctx = await makeTestContext({ claims, billing })
  await ctx.assertExecutionAllowed()
  return ctx
}

// Агенты кладут ctx в state целиком; строка лога `{ state }` не должна выдавать JWT и ключ LLM.
describe('AgentContext в логах', () => {
  it('JSON.stringify на любой глубине отдаёт выжимку без токена, ключа и email', async () => {
    const ctx = await contextWithLlmKey()
    expect(ctx.rawToken).toBe('test.token')
    expect(ctx.llmKey).toBe('sk-test-llm')

    const line = JSON.stringify({ msg: 'handler.run OUT', state: { taskId: 't1', ctx } })

    expect(line).not.toContain('test.token')
    expect(line).not.toContain('sk-test-llm')
    expect(line).not.toContain('person@example.test')
    expect(JSON.parse(line).state.ctx).toEqual({
      sub: 'user-1',
      orgId: 'org-1',
      billingOrgId: 'billing-org-1',
      orgRole: 'OWNER',
      hasToken: true,
      hasLlmKey: true,
    })
  })

  it('util.inspect (console.log) показывает ту же выжимку', async () => {
    const ctx = await contextWithLlmKey()
    const printed = inspect({ state: { ctx } }, { depth: 5 })
    expect(printed).not.toContain('test.token')
    expect(printed).not.toContain('sk-test-llm')
    expect(printed).toContain('hasLlmKey: true')
  })

  it('до preflight ключа нет — флаг false, поля читаются как раньше', async () => {
    const billing = new InMemoryBillingClient({ runtimeState: fixtures.runtimeState.active() })
    const ctx = await makeTestContext({ claims, billing })
    expect(ctx.toJSON()).toMatchObject({ hasToken: true, hasLlmKey: false })
    expect(ctx.rawToken).toBe('test.token')
  })
})
