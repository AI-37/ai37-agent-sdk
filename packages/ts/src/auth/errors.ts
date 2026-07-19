export class AuthError extends Error {
  /** Машинно-читаемая причина: invalid_token | missing_claim | config | forbidden_role.
   *  `forbidden_role` — аутентифицирован, но роли недостаточно (семантика 403, не 401). */
  readonly code: 'invalid_token' | 'missing_claim' | 'config' | 'forbidden_role'

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
