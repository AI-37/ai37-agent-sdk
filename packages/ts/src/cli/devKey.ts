// Локальный dev-keypair, персистится в файл — чтобы dev-jwks (сервер JWKS) и make-token
// (подпись) использовали ОДИН ключ в разных процессах. ТОЛЬКО для разработки/тестов.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose'
import type { JSONWebKeySet, JWK } from 'jose'

export const DEFAULT_KEY_FILE =
  process.env.AI37_DEV_KEY_FILE ?? join(tmpdir(), 'ai37-agent-sdk-dev-key.json')
export const DEV_ISSUER =
  process.env.AI37_OIDC_ISSUER ??
  'https://auth.dev.sp-ai.ru/application/o/sp-ai/'
export const DEV_AUDIENCE = process.env.AI37_OIDC_AUDIENCE ?? 'sp-ai-web'
const KID = 'ai37-dev-key'

interface StoredKey {
  privateJwk: JWK
  publicJwk: JWK
}

export interface DevKey {
  jwks: JSONWebKeySet
  sign(
    claims: Record<string, unknown>,
    opts?: { issuer?: string; audience?: string; expiresIn?: string },
  ): Promise<string>
}

export async function loadOrCreateDevKey(
  keyFile: string = DEFAULT_KEY_FILE,
): Promise<DevKey> {
  let stored: StoredKey
  if (existsSync(keyFile)) {
    stored = JSON.parse(readFileSync(keyFile, 'utf8')) as StoredKey
  } else {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const publicJwk = await exportJWK(publicKey)
    const privateJwk = await exportJWK(privateKey)
    publicJwk.kid = privateJwk.kid = KID
    publicJwk.alg = privateJwk.alg = 'RS256'
    stored = { privateJwk, publicJwk }
    mkdirSync(dirname(keyFile), { recursive: true })
    writeFileSync(keyFile, JSON.stringify(stored), { mode: 0o600 })
  }

  const privateKey = await importJWK(stored.privateJwk, 'RS256')

  return {
    jwks: { keys: [stored.publicJwk] },
    async sign(claims, opts = {}) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuedAt()
        .setIssuer(opts.issuer ?? DEV_ISSUER)
        .setAudience(opts.audience ?? DEV_AUDIENCE)
        .setExpirationTime(opts.expiresIn ?? '1h')
        .sign(privateKey)
    },
  }
}
