// Forward user-JWT при вызове другого агента по A2A (РЕШЕНИЕ 2).
// Зависимости от конкретного A2A-SDK нет: возвращаем fetch-обёртку, которую можно передать
// в A2AClient.fromCardUrl(url, { fetchImpl }) (@a2a-js/sdk) или использовать напрямую.
// message.metadata пробрасывается без изменений → forward-compatible с v2-конвертом metadata.ai37.

export const A2A_PROTOCOL_VERSION = '0.3'

export interface ForwardAuthOptions {
  /** Имя заголовка авторизации. По умолчанию Authorization. */
  headerName?: string
  /** Префикс. По умолчанию Bearer. */
  prefix?: string
  /** Значение заголовка версии A2A. По умолчанию A2A_PROTOCOL_VERSION. */
  protocolVersion?: string
  /** Базовая fetch-реализация. По умолчанию globalThis.fetch. */
  fetch?: typeof fetch
}

export function buildA2AAuthHeaders(
  bearerToken: string,
  options: ForwardAuthOptions = {},
): Record<string, string> {
  const headerName = options.headerName ?? 'Authorization'
  const prefix = options.prefix ?? 'Bearer'
  return {
    [headerName]: `${prefix} ${bearerToken}`,
    'A2A-Version': options.protocolVersion ?? A2A_PROTOCOL_VERSION,
  }
}

/**
 * fetch-обёртка, добавляющая Authorization (forward user-JWT) и A2A-Version к каждому запросу.
 * Остальные заголовки/тело (включая message.metadata) пробрасываются без изменений.
 */
export function forwardAuthFetch(
  bearerToken: string,
  options: ForwardAuthOptions = {},
): typeof fetch {
  const base =
    options.fetch ??
    (typeof globalThis.fetch === 'function'
      ? globalThis.fetch.bind(globalThis)
      : undefined)
  if (!base) {
    throw new Error(
      'forwardAuthFetch: no fetch implementation available. Pass options.fetch.',
    )
  }
  const injected = buildA2AAuthHeaders(bearerToken, options)

  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    for (const [k, v] of Object.entries(injected)) headers.set(k, v)
    return base(input, { ...init, headers })
  }) as typeof fetch
}
