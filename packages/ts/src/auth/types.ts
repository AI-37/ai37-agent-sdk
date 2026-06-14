import type { JSONWebKeySet, JWTVerifyGetKey } from 'jose'

/**
 * Claims user-JWT (см. contract/claims.schema.json).
 * v1.2: один issuer (sp-ai). `app_id` появляется в v2 и опционален.
 */
export interface Claims {
  iss: string
  aud: string | string[]
  sub: string
  exp: number
  iat: number
  nbf?: number
  org_id: string
  billing_org_id: string
  app_id?: string
  email?: string
  name?: string
  [claim: string]: unknown
}

export interface JwtVerifierOptions {
  issuer: string
  /** Ожидаемый audience (строка или список). */
  audience: string | string[]
  /** Допуск по времени (сек) для exp/nbf/iat. По умолчанию 60. */
  leeway?: number
  /** Удалённый JWKS endpoint (createRemoteJWKSet). */
  jwksUrl?: string
  /** Локальный набор ключей (createLocalJWKSet) — для тестов/Уровня 2a. */
  jwks?: JSONWebKeySet
  /** Готовый key-resolver jose (инъекция; имеет приоритет). */
  keyResolver?: JWTVerifyGetKey
}

export interface JwtVerifier {
  verify(token: string): Promise<Claims>
}

/** One trusted issuer in a multi-issuer setup (e.g. product `web` + `widget` channel). */
export interface IssuerConfig {
  issuer: string
  audience: string | string[]
  jwksUrl?: string
  jwks?: JSONWebKeySet
  keyResolver?: JWTVerifyGetKey
}

export interface MultiIssuerVerifierOptions {
  /** Trusted issuers; a token is routed to the one matching its `iss`. */
  issuers: IssuerConfig[]
  /** Допуск по времени (сек), применяется ко всем issuer'ам. По умолчанию 60. */
  leeway?: number
}
