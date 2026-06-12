// Перенос из @ai37/billing-apps-client (src/http.ts).
import { BillingConfigurationError, BillingRequestError } from './errors'
import type { BillingClientOptions, BillingFetch } from './types'

export function normalizeBillingBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '').replace(/\/api\/v\d+$/, '')
}

export function resolveFetch(override?: BillingFetch): BillingFetch {
  if (override) {
    return override
  }

  if (typeof globalThis.fetch !== 'function') {
    throw new BillingConfigurationError(
      'No fetch implementation available. Pass options.fetch when creating the billing client.',
    )
  }

  return globalThis.fetch.bind(globalThis)
}

export function validateOptions(options: BillingClientOptions): void {
  if (!options.baseUrl.trim()) {
    throw new BillingConfigurationError('Billing client baseUrl is required')
  }

  if (!options.authToken.trim()) {
    throw new BillingConfigurationError('Billing client authToken is required')
  }

  if (
    options.runtimeStateCacheTtlMs !== undefined &&
    (!Number.isFinite(options.runtimeStateCacheTtlMs) ||
      options.runtimeStateCacheTtlMs < 0)
  ) {
    throw new BillingConfigurationError(
      'Billing client runtimeStateCacheTtlMs must be a finite number greater than or equal to 0',
    )
  }
}

export async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) {
    return '(empty body)'
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

export function formatErrorBody(body: unknown): string {
  if (typeof body === 'string') {
    return body
  }

  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

export async function ensureOk(
  response: Response,
  messagePrefix: string,
): Promise<Response> {
  if (response.ok) {
    return response
  }

  const body = await readResponseBody(response)
  throw new BillingRequestError(
    `${messagePrefix}: HTTP ${response.status} ${formatErrorBody(body)}`,
    response.status,
    body,
  )
}
