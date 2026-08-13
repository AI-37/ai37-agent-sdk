// Тесты мемоизации JWT-верификатора (см. src/auth/verifierCache.ts):
// один экземпляр на состав настроек, изоляция конфигов, ротация ключей,
// обход кэша для override и несериализуемых конфигов.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import type { JSONWebKeySet, JWK } from 'jose'
import { AgentContext, AuthError } from '../src'
import type { AgentContextSettings, Claims, JwtVerifier } from '../src'
import {
  clearVerifierCache,
  getOrBuildVerifier,
  verifierCacheKey,
  verifierCacheSize,
} from '../src/auth/verifierCache'

const ISSUER = 'https://auth.dev.sp-ai.ru/application/o/sp-ai/'
const AUDIENCE = 'sp-ai-web'
const OTHER_ISSUER = 'https://auth.dev.sp-ai.ru/application/o/widgets/'

const baseClaims = {
  sub: 'user-1',
  org_id: 'user-1',
  billing_org_id: 'org-1',
}

interface Keyset {
  jwk: JWK
  sign: (
    claims: Record<string, unknown>,
    opts?: { iss?: string; aud?: string },
  ) => Promise<string>
}

async function makeKeyset(kid: string): Promise<Keyset> {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = await exportJWK(publicKey)
  jwk.kid = kid
  jwk.alg = 'RS256'
  const sign = (
    claims: Record<string, unknown>,
    opts: { iss?: string; aud?: string } = {},
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuedAt()
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setExpirationTime('1h')
      .sign(privateKey)
  return { jwk, sign }
}

interface CountingServer {
  url: string
  hits: () => number
  setBody: (body: unknown) => void
  close: () => Promise<void>
}

/** Локальный HTTP-сервер со счётчиком обращений (JWKS или introspection). */
function startCountingServer(initialBody: unknown): Promise<CountingServer> {
  let hits = 0
  let body = initialBody
  const server = createServer((_req, res) => {
    hits += 1
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}/`,
        hits: () => hits,
        setBody: (next) => {
          body = next
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

/** Свежий объект настроек на каждый вызов — структурно равный, но не идентичный. */
function makeSettings(
  auth: AgentContextSettings['auth'],
): AgentContextSettings {
  return {
    auth,
    billing: { baseUrl: 'http://127.0.0.1:9/billing', appsAuthToken: 'apps-auth' },
  }
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

beforeEach(() => {
  clearVerifierCache()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('verifierCacheKey', () => {
  const base: AgentContextSettings['auth'] = {
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: 'http://a/jwks',
    leeway: 60,
    introspection: { url: 'http://i/introspect', appsToken: 'apps-1', cacheTtlMs: 1000 },
  }

  it('структурно равные конфиги дают один ключ; audience нормализуется', () => {
    expect(verifierCacheKey({ ...base })).toBe(verifierCacheKey({ ...base }))
    expect(verifierCacheKey({ ...base, audience: [AUDIENCE] })).toBe(
      verifierCacheKey({ ...base, audience: AUDIENCE }),
    )
  })

  it('required не входит в ключ (на верификатор не влияет)', () => {
    expect(verifierCacheKey({ ...base, required: false })).toBe(
      verifierCacheKey({ ...base, required: true }),
    )
  })

  it('каждое поле состава по отдельности меняет ключ', () => {
    const variants: AgentContextSettings['auth'][] = [
      { ...base, issuer: OTHER_ISSUER },
      { ...base, audience: 'other-app' },
      { ...base, jwksUrl: 'http://b/jwks' },
      { ...base, leeway: 30 },
      { ...base, introspection: { ...base.introspection!, url: 'http://other' } },
      { ...base, introspection: { ...base.introspection!, appsToken: 'apps-2' } },
      { ...base, introspection: { ...base.introspection!, cacheTtlMs: 2000 } },
      {
        ...base,
        issuers: [{ issuer: ISSUER, audience: AUDIENCE, jwksUrl: 'http://c/jwks' }],
      },
    ]
    const baseKey = verifierCacheKey(base)
    for (const variant of variants) {
      expect(verifierCacheKey(variant)).not.toBe(baseKey)
    }
  })

  it('состав issuers[] входит в ключ целиком', () => {
    const a: AgentContextSettings['auth'] = {
      issuers: [
        { issuer: ISSUER, audience: AUDIENCE, jwksUrl: 'http://a/jwks' },
        { issuer: OTHER_ISSUER, audience: 'widgets-agent', jwksUrl: 'http://b/jwks' },
      ],
    }
    const b: AgentContextSettings['auth'] = {
      issuers: [
        { issuer: ISSUER, audience: AUDIENCE, jwksUrl: 'http://a/jwks' },
        { issuer: OTHER_ISSUER, audience: 'widgets-agent', jwksUrl: 'http://OTHER/jwks' },
      ],
    }
    expect(verifierCacheKey(a)).not.toBe(verifierCacheKey(b))
  })

  it('несериализуемый конфиг (jwks/keyResolver в issuers[]) → undefined', () => {
    const withJwks: AgentContextSettings['auth'] = {
      issuers: [{ issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [] } }],
    }
    const withResolver: AgentContextSettings['auth'] = {
      issuers: [
        { issuer: ISSUER, audience: AUDIENCE, keyResolver: (() => {}) as never },
      ],
    }
    expect(verifierCacheKey(withJwks)).toBeUndefined()
    expect(verifierCacheKey(withResolver)).toBeUndefined()
  })
})

describe('getOrBuildVerifier', () => {
  const fakeVerifier = (): JwtVerifier => ({
    verify: async () => baseClaims as unknown as Claims,
  })

  it('один состав → один экземпляр, builder вызывается один раз', () => {
    const build = vi.fn(fakeVerifier)
    const auth = (): AgentContextSettings['auth'] => ({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: 'http://a/jwks',
    })
    const v1 = getOrBuildVerifier(auth(), build)
    const v2 = getOrBuildVerifier(auth(), build)
    expect(v1).toBe(v2)
    expect(build).toHaveBeenCalledTimes(1)
    expect(verifierCacheSize()).toBe(1)
  })

  it('разные составы → разные экземпляры', () => {
    const build = vi.fn(fakeVerifier)
    const v1 = getOrBuildVerifier(
      { issuer: ISSUER, audience: AUDIENCE, jwksUrl: 'http://a/jwks' },
      build,
    )
    const v2 = getOrBuildVerifier(
      { issuer: OTHER_ISSUER, audience: AUDIENCE, jwksUrl: 'http://a/jwks' },
      build,
    )
    expect(v1).not.toBe(v2)
    expect(build).toHaveBeenCalledTimes(2)
    expect(verifierCacheSize()).toBe(2)
  })

  it('несериализуемый конфиг → свежая сборка на каждый вызов, кэш не растёт', () => {
    const build = vi.fn(fakeVerifier)
    const auth = (): AgentContextSettings['auth'] => ({
      issuers: [{ issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [] } }],
    })
    const v1 = getOrBuildVerifier(auth(), build)
    const v2 = getOrBuildVerifier(auth(), build)
    expect(v1).not.toBe(v2)
    expect(build).toHaveBeenCalledTimes(2)
    expect(verifierCacheSize()).toBe(0)
  })
})

describe('AgentContext.fromRequest: переиспользование верификатора', () => {
  it('повторный запрос с тем же составом не ходит за JWKS', async () => {
    const ks = await makeKeyset('key-1')
    const server = await startCountingServer({ keys: [ks.jwk] } as JSONWebKeySet)
    try {
      const token = await ks.sign(baseClaims)
      const auth = (): AgentContextSettings['auth'] => ({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: server.url,
      })
      const ctx1 = await AgentContext.fromRequest(
        authHeaders(token),
        makeSettings(auth()),
      )
      const ctx2 = await AgentContext.fromRequest(
        authHeaders(token),
        makeSettings(auth()),
      )
      expect(ctx1.claims?.sub).toBe('user-1')
      expect(ctx2.claims?.sub).toBe('user-1')
      expect(server.hits()).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('изоляция конфигов: токен первого конфига отвергается вторым', async () => {
    const ksA = await makeKeyset('key-a')
    const ksB = await makeKeyset('key-b')
    const serverA = await startCountingServer({ keys: [ksA.jwk] })
    const serverB = await startCountingServer({ keys: [ksB.jwk] })
    try {
      const tokenA = await ksA.sign(baseClaims)
      const settingsA = makeSettings({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: serverA.url,
      })
      const settingsB = makeSettings({
        issuer: OTHER_ISSUER,
        audience: AUDIENCE,
        jwksUrl: serverB.url,
      })
      const ctxA = await AgentContext.fromRequest(authHeaders(tokenA), settingsA)
      expect(ctxA.claims?.billing_org_id).toBe('org-1')
      await expect(
        AgentContext.fromRequest(authHeaders(tokenA), settingsB),
      ).rejects.toBeInstanceOf(AuthError)
      expect(verifierCacheSize()).toBe(2)
    } finally {
      await serverA.close()
      await serverB.close()
    }
  })

  it('ротация ключей: неизвестный kid дозагружает JWKS на живом верификаторе', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const ksOld = await makeKeyset('key-old')
    const ksNew = await makeKeyset('key-new')
    const server = await startCountingServer({ keys: [ksOld.jwk] })
    try {
      const auth = (): AgentContextSettings['auth'] => ({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: server.url,
      })
      const tokenOld = await ksOld.sign(baseClaims)
      await AgentContext.fromRequest(authHeaders(tokenOld), makeSettings(auth()))
      expect(server.hits()).toBe(1)

      // Ротация: эндпоинт отдаёт обновлённый набор; cooldown jose (30с) пережидаем фейковым Date.
      server.setBody({ keys: [ksOld.jwk, ksNew.jwk] })
      vi.setSystemTime(Date.now() + 31_000)
      const tokenNew = await ksNew.sign(baseClaims)
      const ctx = await AgentContext.fromRequest(
        authHeaders(tokenNew),
        makeSettings(auth()),
      )
      expect(ctx.claims?.sub).toBe('user-1')
      expect(server.hits()).toBe(2)
    } finally {
      await server.close()
    }
  })

  it('overrides.verifier обходит кэш и не подменяется закэшированным', async () => {
    const ks = await makeKeyset('key-1')
    const server = await startCountingServer({ keys: [ks.jwk] })
    try {
      const token = await ks.sign(baseClaims)
      const auth = (): AgentContextSettings['auth'] => ({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: server.url,
      })

      // Прогрев кэша обычным путём.
      await AgentContext.fromRequest(authHeaders(token), makeSettings(auth()))
      expect(verifierCacheSize()).toBe(1)
      expect(server.hits()).toBe(1)

      // Явный верификатор: используется он, кэш и JWKS не трогаются.
      const overrideClaims = { ...baseClaims, sub: 'override-user' }
      const override: JwtVerifier = {
        verify: async () => overrideClaims as unknown as Claims,
      }
      const ctxOverride = await AgentContext.fromRequest(
        authHeaders(token),
        makeSettings(auth()),
        { verifier: override },
      )
      expect(ctxOverride.claims?.sub).toBe('override-user')
      expect(verifierCacheSize()).toBe(1)
      expect(server.hits()).toBe(1)

      // Следующий вызов без override — прежний закэшированный экземпляр.
      const ctx = await AgentContext.fromRequest(
        authHeaders(token),
        makeSettings(auth()),
      )
      expect(ctx.claims?.sub).toBe('user-1')
      expect(server.hits()).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('jwks-конфиг (локальные ключи) работает, кэш не растёт', async () => {
    const ks = await makeKeyset('key-1')
    const token = await ks.sign(baseClaims)
    const auth = (): AgentContextSettings['auth'] => ({
      issuers: [{ issuer: ISSUER, audience: AUDIENCE, jwks: { keys: [ks.jwk] } }],
    })
    const ctx1 = await AgentContext.fromRequest(
      authHeaders(token),
      makeSettings(auth()),
    )
    const ctx2 = await AgentContext.fromRequest(
      authHeaders(token),
      makeSettings(auth()),
    )
    expect(ctx1.claims?.sub).toBe('user-1')
    expect(ctx2.claims?.sub).toBe('user-1')
    expect(verifierCacheSize()).toBe(0)
  })

  it('композитный канал: opaque-ключ идёт в introspection, JWT — в JWKS', async () => {
    const ks = await makeKeyset('key-1')
    const jwksServer = await startCountingServer({ keys: [ks.jwk] })
    const introServer = await startCountingServer({
      active: true,
      claims: { sub: 'api-user', org_id: 'api-user', billing_org_id: 'org-9' },
    })
    try {
      const auth = (): AgentContextSettings['auth'] => ({
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: jwksServer.url,
        introspection: { url: introServer.url, appsToken: 'apps-token' },
      })

      const ctxOpaque = await AgentContext.fromRequest(
        authHeaders('api-key-secret'),
        makeSettings(auth()),
      )
      expect(ctxOpaque.claims?.billing_org_id).toBe('org-9')
      expect(introServer.hits()).toBe(1)

      // Повтор того же ключа: claims-кэш живого OpaqueTokenVerifier, без второго похода.
      await AgentContext.fromRequest(
        authHeaders('api-key-secret'),
        makeSettings(auth()),
      )
      expect(introServer.hits()).toBe(1)

      // JWT тем же составом настроек — JWKS-канал того же композита.
      const token = await ks.sign(baseClaims)
      const ctxJwt = await AgentContext.fromRequest(
        authHeaders(token),
        makeSettings(auth()),
      )
      expect(ctxJwt.claims?.sub).toBe('user-1')
      expect(jwksServer.hits()).toBe(1)
      expect(verifierCacheSize()).toBe(1)
    } finally {
      await jwksServer.close()
      await introServer.close()
    }
  })
})
