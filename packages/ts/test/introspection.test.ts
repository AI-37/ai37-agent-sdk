import { describe, expect, it, vi } from 'vitest'
import {
  AuthError,
  CompositeVerifier,
  OpaqueTokenVerifier,
  createCompositeVerifier,
  looksLikeJwt,
} from '../src'
import type { Claims, JwtVerifier } from '../src'

const URL = 'https://billing.test/internal/api-keys/introspect'
const APPS_TOKEN = 'apps-token'
const OPAQUE_KEY = 'ak_opaque_value_without_dots'

const ACTIVE_CLAIMS = {
  sub: 'user-uuid',
  org_id: 'user-uuid',
  billing_org_id: 'billing-1',
  email: 'u@example.com',
  name: 'User',
  exp: 1893456000,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('looksLikeJwt', () => {
  it('detects three-segment tokens as JWT', () => {
    expect(looksLikeJwt('aaa.bbb.ccc')).toBe(true)
    expect(looksLikeJwt(OPAQUE_KEY)).toBe(false)
    expect(looksLikeJwt('only.two')).toBe(false)
  })
})

describe('OpaqueTokenVerifier', () => {
  it('returns normalized claims for an active key', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ active: true, claims: ACTIVE_CLAIMS }))
    const verifier = new OpaqueTokenVerifier({ url: URL, appsToken: APPS_TOKEN, fetch: fetchMock })

    const claims = await verifier.verify(OPAQUE_KEY)

    expect(claims.sub).toBe('user-uuid')
    expect(claims.org_id).toBe('user-uuid')
    expect(claims.billing_org_id).toBe('billing-1')
    expect(claims.email).toBe('u@example.com')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(calledUrl).toBe(URL)
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${APPS_TOKEN}`)
    expect(JSON.parse(init.body as string)).toEqual({ key: OPAQUE_KEY })
  })

  it('caches positive results by key (no second fetch)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ active: true, claims: ACTIVE_CLAIMS }))
    const verifier = new OpaqueTokenVerifier({ url: URL, appsToken: APPS_TOKEN, fetch: fetchMock })

    await verifier.verify(OPAQUE_KEY)
    await verifier.verify(OPAQUE_KEY)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws for an inactive key', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ active: false, claims: null }))
    const verifier = new OpaqueTokenVerifier({ url: URL, appsToken: APPS_TOKEN, fetch: fetchMock })

    await expect(verifier.verify(OPAQUE_KEY)).rejects.toBeInstanceOf(AuthError)
  })

  it('throws on non-2xx introspection response', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ detail: 'nope' }, 401))
    const verifier = new OpaqueTokenVerifier({ url: URL, appsToken: APPS_TOKEN, fetch: fetchMock })

    await expect(verifier.verify(OPAQUE_KEY)).rejects.toBeInstanceOf(AuthError)
  })

  it('throws missing_claim when required claim absent', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ active: true, claims: { sub: 'u', org_id: 'u' } }),
    )
    const verifier = new OpaqueTokenVerifier({ url: URL, appsToken: APPS_TOKEN, fetch: fetchMock })

    await expect(verifier.verify(OPAQUE_KEY)).rejects.toMatchObject({ code: 'missing_claim' })
  })

  it('requires url and appsToken', () => {
    expect(() => new OpaqueTokenVerifier({ url: '', appsToken: APPS_TOKEN })).toThrow(AuthError)
    expect(() => new OpaqueTokenVerifier({ url: URL, appsToken: '' })).toThrow(AuthError)
  })
})

describe('CompositeVerifier', () => {
  const stub = (label: string): JwtVerifier => ({
    verify: vi.fn(async () => ({ sub: label }) as unknown as Claims),
  })

  it('routes JWT-shaped tokens to the jwt verifier', async () => {
    const jwt = stub('jwt')
    const opaque = stub('opaque')
    const composite = new CompositeVerifier({ jwt, opaque })

    const claims = await composite.verify('aaa.bbb.ccc')

    expect(claims.sub).toBe('jwt')
    expect(jwt.verify).toHaveBeenCalledTimes(1)
    expect(opaque.verify).not.toHaveBeenCalled()
  })

  it('routes opaque tokens to the opaque verifier', async () => {
    const jwt = stub('jwt')
    const opaque = stub('opaque')
    const composite = new CompositeVerifier({ jwt, opaque })

    const claims = await composite.verify(OPAQUE_KEY)

    expect(claims.sub).toBe('opaque')
    expect(opaque.verify).toHaveBeenCalledTimes(1)
    expect(jwt.verify).not.toHaveBeenCalled()
  })

  it('throws config error when the needed channel is missing', async () => {
    const opaqueOnly = new CompositeVerifier({ opaque: stub('opaque') })
    await expect(opaqueOnly.verify('aaa.bbb.ccc')).rejects.toMatchObject({ code: 'config' })
  })
})

describe('createCompositeVerifier', () => {
  const jwt = { verify: vi.fn(async () => ({}) as Claims) } as JwtVerifier

  it('returns the jwt verifier directly when only jwt is configured', () => {
    expect(createCompositeVerifier({ jwt })).toBe(jwt)
  })

  it('returns an opaque verifier when only introspection is configured', () => {
    const verifier = createCompositeVerifier({
      introspection: { url: URL, appsToken: APPS_TOKEN },
    })
    expect(verifier).toBeInstanceOf(OpaqueTokenVerifier)
  })

  it('returns a composite when both channels are configured', () => {
    const verifier = createCompositeVerifier({
      jwt,
      introspection: { url: URL, appsToken: APPS_TOKEN },
    })
    expect(verifier).toBeInstanceOf(CompositeVerifier)
  })

  it('throws when neither channel is configured', () => {
    expect(() => createCompositeVerifier({})).toThrow(AuthError)
  })
})
