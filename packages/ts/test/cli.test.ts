import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBillingClient, createJwtVerifier } from '../src'
import {
  DEV_AUDIENCE,
  DEV_ISSUER,
  loadOrCreateDevKey,
} from '../src/cli/devKey'
import { startDevJwks } from '../src/cli/devJwks'
import { startDevBilling } from '../src/cli/devBilling'

const keyFile = join(tmpdir(), `ai37-test-key-${process.pid}-${Date.now()}.json`)

afterEach(() => {
  try {
    rmSync(keyFile)
  } catch {
    /* noop */
  }
})

describe('CLI dev-серверы (Уровень 2)', () => {
  it('dev-jwks + make-token: подписанный токен верифицируется через jwksUrl', async () => {
    const jwks = await startDevJwks({ keyFile })
    try {
      const key = await loadOrCreateDevKey(keyFile)
      const token = await key.sign({
        sub: 'u1',
        org_id: 'u1',
        billing_org_id: 'org-1',
        app_id: 'sp-ai',
      })

      const verifier = createJwtVerifier({
        issuer: DEV_ISSUER,
        audience: DEV_AUDIENCE,
        jwksUrl: jwks.url,
      })
      const claims = await verifier.verify(token)
      expect(claims.billing_org_id).toBe('org-1')
    } finally {
      await jwks.close()
    }
  })

  it('dev-billing: billing-клиент читает state и шлёт usage', async () => {
    const billing = await startDevBilling({ fixture: 'active' })
    try {
      const client = createBillingClient({
        baseUrl: billing.baseUrl,
        authToken: 'test-token',
        usageIngestToken: 'test-token',
        runtimeStateCacheTtlMs: 0,
      })
      const state = await client.assertExecutionAllowed('org-1')
      expect(state.billingOrgId).toBe('org-1')
      expect(state.llmKey).toBe('sk-test-llm')

      await client.sendUsageEvent({
        transactionId: 'task-1',
        billingRuntimeState: state,
        code: 'lift_calculation',
      })

      const res = await fetch(`${billing.baseUrl}/__debug/usage`)
      const recorded = (await res.json()) as Array<{ event: { code: string } }>
      expect(recorded).toHaveLength(1)
      expect(recorded[0].event.code).toBe('lift_calculation')
    } finally {
      await billing.close()
    }
  })
})
