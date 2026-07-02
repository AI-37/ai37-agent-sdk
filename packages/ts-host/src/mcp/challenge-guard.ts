import type { NextFunction, Request, Response } from 'express'
import {
  AgentContext,
  AuthError,
  extractBearer,
  type AgentContextOverrides,
  type AgentContextSettings,
} from '@ai37/agent-sdk'
import { requestScope } from '../als'

/**
 * MCP-вариант JWT-guard'а. Отличие от `jwtGuard` (A2A/AG-UI) — в поведении на 401: по
 * MCP-спеке (RFC 9728) сервер ОБЯЗАН вернуть `WWW-Authenticate: Bearer resource_metadata="…"`,
 * чтобы клиент нашёл AS и начал OAuth. Проверка токена — тем же `AgentContext.fromRequest`
 * (multi-issuer JWT → JWKS, иначе → introspection API-ключа), и так же открывается ALS-scope
 * (`requestScope`), чтобы MCP-tool handler мог прочитать `currentCtx()` — кто вызвал.
 *
 * `resourceMetadataUrl` — абсолютный URL protected-resource-metadata (см. `protectedResourceMetadataUrl`).
 */
export function mcpChallengeGuard(
  settings: AgentContextSettings,
  required: boolean,
  resourceMetadataUrl: string,
  overrides: AgentContextOverrides = {},
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const ctx = await AgentContext.fromRequest(req.headers, settings, overrides)
      requestScope.run(
        { ctx, bearer: extractBearer(req.headers) },
        () => next(),
      )
    } catch (e) {
      if (e instanceof AuthError && required) {
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
      // required=false (миграция) — пропускаем без ctx.
      requestScope.run({ ctx: undefined, bearer: undefined }, () => next())
    }
  }
}
