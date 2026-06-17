import type { NextFunction, Request, Response } from 'express'
import {
  AgentContext,
  AuthError,
  extractBearer,
  type AgentContextOverrides,
  type AgentContextSettings,
} from '@ai37/agent-sdk'
import { requestScope } from './als'

/**
 * Express-middleware: строит verified `AgentContext` из заголовков и открывает
 * request-scope. При `required` и невалидном/отсутствующем токене → 401.
 * При `required=false` — пропускает без ctx (миграция).
 *
 * `overrides` (verifier/billingClient) — точка внедрения dev-режима
 * (`buildDevContextOverrides` из `@ai37/agent-sdk/dev`); по умолчанию пусто → прод-поведение.
 */
export function jwtGuard(
  settings: AgentContextSettings,
  required: boolean,
  overrides: AgentContextOverrides = {},
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const ctx = await AgentContext.fromRequest(req.headers, settings, overrides)
      requestScope.run({ ctx, bearer: extractBearer(req.headers) }, () => next())
    } catch (e) {
      if (e instanceof AuthError && required) {
        res.status(401).json({ error: 'unauthorized', detail: e.message })
        return
      }
      requestScope.run({ ctx: undefined, bearer: undefined }, () => next())
    }
  }
}
