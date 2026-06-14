import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose'
import { AuthError } from './errors'
import type {
  Claims,
  JwtVerifier,
  JwtVerifierOptions,
  MultiIssuerVerifierOptions,
} from './types'

/**
 * Верификатор user-JWT через JWKS. Делегирует кэш ключей (по kid, ротация, single-flight)
 * библиотеке jose. Источник ключей — удалённый jwksUrl, локальный набор jwks или инъекция keyResolver.
 */
export class JwksJwtVerifier implements JwtVerifier {
  private readonly issuer: string
  private readonly audience: string | string[]
  private readonly leeway: number
  private readonly keyResolver: JWTVerifyGetKey

  constructor(options: JwtVerifierOptions) {
    if (!options.issuer?.trim()) {
      throw new AuthError('JwtVerifier: issuer is required', 'config')
    }
    if (
      options.audience === undefined ||
      (Array.isArray(options.audience) && options.audience.length === 0)
    ) {
      throw new AuthError('JwtVerifier: audience is required', 'config')
    }

    this.issuer = options.issuer
    this.audience = options.audience
    this.leeway = options.leeway ?? 60

    if (options.keyResolver) {
      this.keyResolver = options.keyResolver
    } else if (options.jwks) {
      this.keyResolver = createLocalJWKSet(options.jwks)
    } else if (options.jwksUrl) {
      this.keyResolver = createRemoteJWKSet(new URL(options.jwksUrl))
    } else {
      throw new AuthError(
        'JwtVerifier: one of jwksUrl, jwks or keyResolver is required',
        'config',
      )
    }
  }

  async verify(token: string): Promise<Claims> {
    if (!token?.trim()) {
      throw new AuthError('Empty bearer token')
    }

    let payload: Record<string, unknown>
    try {
      const result = await jwtVerify(token, this.keyResolver, {
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: this.leeway,
      })
      payload = result.payload as Record<string, unknown>
    } catch (cause) {
      throw new AuthError('JWT verification failed', 'invalid_token', { cause })
    }

    for (const required of ['sub', 'org_id', 'billing_org_id'] as const) {
      if (typeof payload[required] !== 'string' || !payload[required]) {
        throw new AuthError(
          `JWT missing required claim: ${required}`,
          'missing_claim',
        )
      }
    }

    return payload as Claims
  }
}

export function createJwtVerifier(options: JwtVerifierOptions): JwtVerifier {
  return new JwksJwtVerifier(options)
}

/**
 * Верификатор для нескольких доверенных issuer'ов (напр. продукт `web` + канал `widget`).
 * По незаверенному `iss` из токена выбирает соответствующий per-issuer JwksJwtVerifier,
 * который и выполняет полную проверку (подпись/iss/aud/exp). `iss` из payload используется
 * только для маршрутизации — выбранный verifier всё равно сверяет его со своим issuer.
 */
export class MultiIssuerJwtVerifier implements JwtVerifier {
  private readonly byIssuer: Map<string, JwksJwtVerifier>

  constructor(options: MultiIssuerVerifierOptions) {
    if (!options.issuers?.length) {
      throw new AuthError(
        'MultiIssuerJwtVerifier: at least one issuer is required',
        'config',
      )
    }
    this.byIssuer = new Map()
    for (const cfg of options.issuers) {
      if (!cfg.issuer?.trim()) {
        throw new AuthError('MultiIssuerJwtVerifier: issuer is required', 'config')
      }
      if (this.byIssuer.has(cfg.issuer)) {
        throw new AuthError(
          `MultiIssuerJwtVerifier: duplicate issuer ${cfg.issuer}`,
          'config',
        )
      }
      this.byIssuer.set(
        cfg.issuer,
        new JwksJwtVerifier({ ...cfg, leeway: options.leeway }),
      )
    }
  }

  async verify(token: string): Promise<Claims> {
    if (!token?.trim()) {
      throw new AuthError('Empty bearer token')
    }
    let iss: string | undefined
    try {
      iss = decodeJwt(token).iss
    } catch (cause) {
      throw new AuthError('JWT decode failed', 'invalid_token', { cause })
    }
    if (!iss) {
      throw new AuthError('JWT missing iss claim', 'invalid_token')
    }
    const verifier = this.byIssuer.get(iss)
    if (!verifier) {
      throw new AuthError(`Untrusted issuer: ${iss}`, 'invalid_token')
    }
    return verifier.verify(token)
  }
}

export function createMultiIssuerVerifier(
  options: MultiIssuerVerifierOptions,
): JwtVerifier {
  return new MultiIssuerJwtVerifier(options)
}
