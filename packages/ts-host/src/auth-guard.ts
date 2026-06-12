import type { NextFunction, Request, Response } from 'express'
import {
  AgentContext,
  AuthError,
  extractBearer,
  type AgentContextSettings,
} from '@ai37/agent-sdk'
import { requestScope } from './als'

/**
 * Express-middleware: строит verified `AgentContext` из заголовков и открывает
 * request-scope. При `required` и невалидном/отсутствующем токене → 401.
 * При `required=false` — пропускает без ctx (миграция).
 */
export function jwtGuard(settings: AgentContextSettings, required: boolean) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const ctx = await AgentContext.fromRequest(req.headers, settings)
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
