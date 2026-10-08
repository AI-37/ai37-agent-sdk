import type { NextFunction, Request, Response } from 'express'
import {
  AgentContext,
  AuthError,
  extractBearer,
  type AgentContextOverrides,
  type AgentContextSettings,
} from '@ai37/agent-sdk'
import { requestScope } from '../als'
import { reportGuardError } from '../auth-guard'

/**
 * MCP-вариант JWT-guard'а. Отличие от `jwtGuard` (A2A/AG-UI) — в поведении на 401: по
 * MCP-спеке (RFC 9728) сервер ОБЯЗАН вернуть `WWW-Authenticate: Bearer resource_metadata="…"`,
 * чтобы клиент нашёл AS и начал OAuth. Проверка токена — тем же `AgentContext.fromRequest`
 * (multi-issuer JWT → JWKS, иначе → introspection API-ключа), и так же открывается ALS-scope
 * (`requestScope`), чтобы MCP-tool handler мог прочитать `currentCtx()` — кто вызвал.
 *
 * Fail-closed как у `jwtGuard`: при `required` сбой проверки не на `AuthError` (конфиг, недоступная
 * зависимость) → 503 без `WWW-Authenticate` (новый токен тут не поможет), `next()` не вызывается.
 *
 * `resourceMetadataUrl` — абсолютный URL protected-resource-metadata (см. `protectedResourceMetadataUrl`).
 */
export function mcpChallengeGuard(
  settings: AgentContextSettings,
  required: boolean,
  resourceMetadataUrl: string,
  overrides: AgentContextOverrides = {},
  service: string = 'unknown',
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    let ctx: AgentContext | undefined
    try {
      ctx = await AgentContext.fromRequest(req.headers, settings, overrides)
    } catch (e) {
      if (required && e instanceof AuthError) {
        // Challenge по RFC 9728/9110: клиент извлечёт resource_metadata и пойдёт за токеном.
        res.setHeader(
          'WWW-Authenticate',
          `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token"`,
        )
        // Тело в форме JSON-RPC-ошибки (MCP поверх StreamableHTTP), id неизвестен → null.
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'unauthorized' },
          id: null,
        })
        return
      }
      if (required) {
        reportGuardError(service, 'mcp', e)
        res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'auth unavailable' },
          id: null,
        })
        return
      }
      // required=false (миграция) — пропускаем без ctx.
    }
    requestScope.run(
      { ctx, bearer: ctx ? extractBearer(req.headers) : undefined },
      () => next(),
    )
  }
}
