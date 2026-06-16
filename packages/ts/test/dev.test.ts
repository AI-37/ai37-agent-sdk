import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDevContextOverrides, isDevModeRequested } from '../src/dev'
import { FakeJwtVerifier, InMemoryBillingClient } from '../src/testing'

const CLAIMS = {
  iss: 'http://localhost/dev',
  aud: 'ai37-agents',
  sub: 'dev-user-0001',
  exp: 9999999999,
  iat: 0,
  org_id: 'dev-user-0001',
  billing_org_id: 'dev-billing-org',
}

const STATE = {
  orgId: 'dev-user-0001',
  billingOrgId: 'dev-billing-org',
  entitlementStatus: 'active',
  remainingTotalTokens: 42,
  features: [],
  llmKey: 'sk-from-file',
  stale: false,
}

const dirs: string[] = []
function writeTmp(name: string, data: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai37-dev-'))
  dirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(data), 'utf8')
  return path
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('buildDevContextOverrides', () => {
  it('без флагов возвращает {} (поведение не меняется)', () => {
    expect(buildDevContextOverrides({})).toEqual({})
    expect(isDevModeRequested({})).toBe(false)
  })

  it('insecure-dev → FakeJwtVerifier с claims из файла', async () => {
    const claimsFile = writeTmp('claims.json', CLAIMS)
    const o = buildDevContextOverrides({
      AI37_AUTH_MODE: 'insecure-dev',
      AI37_DEV_CLAIMS_FILE: claimsFile,
    })
    expect(o.verifier).toBeInstanceOf(FakeJwtVerifier)
    await expect(o.verifier!.verify('любой-токен')).resolves.toMatchObject({
      sub: 'dev-user-0001',
      billing_org_id: 'dev-billing-org',
    })
    expect(o.billingClient).toBeUndefined()
  })

  it('insecure-dev без AI37_DEV_CLAIMS_FILE бросает', () => {
    expect(() => buildDevContextOverrides({ AI37_AUTH_MODE: 'insecure-dev' })).toThrow(
      /AI37_DEV_CLAIMS_FILE/,
    )
  })

  it('insecure-dev: файл без обязательного claim бросает', () => {
    const bad = writeTmp('claims.json', { sub: 'x', org_id: 'x' }) // нет billing_org_id
    expect(() =>
      buildDevContextOverrides({ AI37_AUTH_MODE: 'insecure-dev', AI37_DEV_CLAIMS_FILE: bad }),
    ).toThrow(/billing_org_id/)
  })

  it('BILLING_MODE=fake → InMemoryBillingClient с состоянием из файла', async () => {
    const stateFile = writeTmp('billing.json', STATE)
    const o = buildDevContextOverrides({
      BILLING_MODE: 'fake',
      BILLING_STATE_FILE: stateFile,
    })
    expect(o.billingClient).toBeInstanceOf(InMemoryBillingClient)
    const state = await o.billingClient!.getRuntimeStateByBillingOrgId('whatever')
    expect(state.remainingTotalTokens).toBe(42)
    expect(state.llmKey).toBe('sk-from-file')
  })

  it('BILLING_MODE=fake без файла берёт фикстуру active()', async () => {
    const o = buildDevContextOverrides({ BILLING_MODE: 'fake' })
    const state = await o.billingClient!.getRuntimeStateByBillingOrgId('whatever')
    expect(state.entitlementStatus).toBe('active')
  })

  it('оба флага вместе → verifier + billingClient', () => {
    const claimsFile = writeTmp('claims.json', CLAIMS)
    const stateFile = writeTmp('billing.json', STATE)
    const o = buildDevContextOverrides({
      AI37_AUTH_MODE: 'insecure-dev',
      AI37_DEV_CLAIMS_FILE: claimsFile,
      BILLING_MODE: 'fake',
      BILLING_STATE_FILE: stateFile,
    })
    expect(o.verifier).toBeInstanceOf(FakeJwtVerifier)
    expect(o.billingClient).toBeInstanceOf(InMemoryBillingClient)
  })

  describe('prod-guard (fail-closed)', () => {
    it('бросает при NODE_ENV=production', () => {
      expect(() =>
        buildDevContextOverrides({ BILLING_MODE: 'fake', NODE_ENV: 'production' }),
      ).toThrow(/прод/)
    })

    it('бросает при ENV=prod', () => {
      expect(() =>
        buildDevContextOverrides({ AI37_AUTH_MODE: 'insecure-dev', ENV: 'prod' }),
      ).toThrow(/прод/)
    })

    it('бросает при боевом https-issuer', () => {
      expect(() =>
        buildDevContextOverrides({
          BILLING_MODE: 'fake',
          AI37_OIDC_ISSUER: 'https://auth.dev.sp-ai.ru/application/o/sp-ai/',
        }),
      ).toThrow(/прод/)
    })

    it('НЕ бросает при localhost-issuer', () => {
      expect(() =>
        buildDevContextOverrides({
          BILLING_MODE: 'fake',
          AI37_OIDC_ISSUER: 'http://localhost:9000/application/o/sp-ai/',
        }),
      ).not.toThrow()
    })
  })
})
