import { describe, expect, it } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { AuthError, createJwtVerifier, extractBearer } from '../src'
import type { JSONWebKeySet } from 'jose'

const ISSUER = 'https://auth.dev.sp-ai.ru/application/o/sp-ai/'
const AUDIENCE = 'sp-ai-web'
const KID = 'test-key-1'

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const publicJwk = await exportJWK(publicKey)
  publicJwk.kid = KID
  publicJwk.alg = 'RS256'
  const jwks: JSONWebKeySet = { keys: [publicJwk] }

  async function sign(
    claims: Record<string, unknown>,
    opts: { iss?: string; aud?: string; exp?: string } = {},
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt()
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setExpirationTime(opts.exp ?? '1h')
      .sign(privateKey)
  }

  const verifier = createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks })
  return { sign, verifier }
}

const baseClaims = {
  sub: 'user-1',
  org_id: 'user-1',
  billing_org_id: 'org-1',
  app_id: 'sp-ai',
}

describe('JwtVerifier', () => {
  it('верифицирует валидный токен и возвращает claims', async () => {
    const { sign, verifier } = await setup()
    const token = await sign(baseClaims)
    const claims = await verifier.verify(token)
    expect(claims.sub).toBe('user-1')
    expect(claims.billing_org_id).toBe('org-1')
    expect(claims.app_id).toBe('sp-ai')
  })

  it('отклоняет просроченный токен', async () => {
    const { sign, verifier } = await setup()
    const token = await sign(baseClaims, { exp: '-1h' })
    await expect(verifier.verify(token)).rejects.toMatchObject({
      name: 'AuthError',
      code: 'invalid_token',
    })
  })

  it('отклоняет чужой issuer', async () => {
    const { sign, verifier } = await setup()
    const token = await sign(baseClaims, { iss: 'https://evil.example/' })
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AuthError)
  })

  it('отклоняет чужой audience', async () => {
    const { sign, verifier } = await setup()
    const token = await sign(baseClaims, { aud: 'other-app' })
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AuthError)
  })

  it('отклоняет токен без обязательного claim (billing_org_id)', async () => {
    const { sign, verifier } = await setup()
    const token = await sign({ sub: 'user-1', org_id: 'user-1' })
    await expect(verifier.verify(token)).rejects.toMatchObject({
      code: 'missing_claim',
    })
  })

  it('отклоняет подпись чужим ключом', async () => {
    const { verifier } = await setup()
    const other = await generateKeyPair('RS256')
    const forged = await new SignJWT(baseClaims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('1h')
      .sign(other.privateKey)
    await expect(verifier.verify(forged)).rejects.toBeInstanceOf(AuthError)
  })
})

describe('extractBearer', () => {
  it('достаёт токен из Headers', () => {
    const h = new Headers({ Authorization: 'Bearer abc.def.ghi' })
    expect(extractBearer(h)).toBe('abc.def.ghi')
  })
  it('достаёт из plain-объекта регистронезависимо', () => {
    expect(extractBearer({ authorization: 'Bearer xyz' })).toBe('xyz')
  })
  it('возвращает undefined без заголовка', () => {
    expect(extractBearer({})).toBeUndefined()
    expect(extractBearer(undefined)).toBeUndefined()
  })
})
