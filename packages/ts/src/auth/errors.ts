export class AuthError extends Error {
  /** Машинно-читаемая причина: invalid_token | missing_claim | config */
  readonly code: 'invalid_token' | 'missing_claim' | 'config'

  constructor(
    message: string,
    code: AuthError['code'] = 'invalid_token',
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AuthError'
    this.code = code
  }
}
