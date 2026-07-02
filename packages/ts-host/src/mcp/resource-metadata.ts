import { Router, type Request, type Response } from 'express'

export interface ProtectedResourceMetadataOptions {
  /** Канонический публичный URL MCP-эндпоинта, напр. `https://elev-calc-agent.app.sp-ai.ru/mcp`. */
  resource: string
  /**
   * Authorization Server(ы), выдающие токены для этого ресурса — issuer-идентификаторы
   * (Authentik). Клиент сам добавит `/.well-known/oauth-authorization-server` (RFC 8414)
   * или `/.well-known/openid-configuration` и продолжит discovery.
   */
  authorizationServers: string[]
  /** Публикуемые scopes (`scopes_supported`). */
  scopesSupported?: string[]
  /** Человекочитаемое имя ресурса (для consent-экранов клиентов). */
  resourceName?: string
}

/**
 * URL документа protected-resource-metadata (RFC 9728) для данного MCP-URL: путь ресурса
 * переносится в СУФФИКС `.well-known`-пути (`https://h/mcp` → `https://h/.well-known/oauth-protected-resource/mcp`).
 * Этот URL кладётся в заголовок `WWW-Authenticate: Bearer resource_metadata="…"`.
 */
export function protectedResourceMetadataUrl(mcpUrl: string): string {
  const u = new URL(mcpUrl)
  const path = u.pathname === '/' ? '' : u.pathname
  return `${u.origin}/.well-known/oauth-protected-resource${path}`
}

/**
 * Express-роутер, отдающий документ protected-resource-metadata (RFC 9728) — точку входа
 * OAuth-discovery: клиент узнаёт, к какому AS (Authentik) идти за токеном. Монтируется ДО
 * guard'а (метаданные публичны). Отдаём и корневой путь, и path-суффиксный вариант — клиенты
 * пробуют оба.
 */
export function protectedResourceMetadataRouter(
  opts: ProtectedResourceMetadataOptions,
): Router {
  const body = {
    resource: opts.resource,
    authorization_servers: opts.authorizationServers,
    ...(opts.scopesSupported?.length
      ? { scopes_supported: opts.scopesSupported }
      : {}),
    ...(opts.resourceName ? { resource_name: opts.resourceName } : {}),
    bearer_methods_supported: ['header'],
  }
  const suffix = protectedResourceMetadataUrl(opts.resource).replace(
    new URL(opts.resource).origin,
    '',
  )

  const r = Router()
  const handler = (_req: Request, res: Response): void => {
    res.json(body)
  }
  // RFC 9728 §3.1: и корневой `/.well-known/oauth-protected-resource`, и path-суффиксный.
  r.get('/.well-known/oauth-protected-resource', handler)
  if (suffix !== '/.well-known/oauth-protected-resource') {
    r.get(suffix, handler)
  }
  return r
}
