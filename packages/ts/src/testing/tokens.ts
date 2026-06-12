// Локальный keyset + подписанные токены для тестов и Уровня 2a (реальная верификация без сети).
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import type { JSONWebKeySet } from 'jose'

export const TEST_ISSUER = 'https://auth.dev.sp-ai.ru/application/o/sp-ai/'
export const TEST_AUDIENCE = 'sp-ai-web'

export interface TestKeyset {
  /** Публичный JWKS (для JwtVerifier { jwks }). */
  jwks: JSONWebKeySet
  /** Подписать claims тестовым приватным ключом. */
  sign(
    claims: Record<string, unknown>,
    opts?: { issuer?: string; audience?: string; expiresIn?: string; kid?: string },
  ): Promise<string>
}

export async function createTestKeyset(
  opts: { kid?: string } = {},
): Promise<TestKeyset> {
  const kid = opts.kid ?? 'ai37-test-key'
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const publicJwk = await exportJWK(publicKey)
  publicJwk.kid = kid
  publicJwk.alg = 'RS256'

  return {
    jwks: { keys: [publicJwk] },
    async sign(claims, signOpts = {}) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: signOpts.kid ?? kid })
        .setIssuedAt()
        .setIssuer(signOpts.issuer ?? TEST_ISSUER)
        .setAudience(signOpts.audience ?? TEST_AUDIENCE)
        .setExpirationTime(signOpts.expiresIn ?? '1h')
        .sign(privateKey)
    },
  }
}
