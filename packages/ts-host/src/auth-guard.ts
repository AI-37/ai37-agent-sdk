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
 * Достаёт нативный `params.configuration.acceptedOutputModes` из тела A2A JSON-RPC
 * (`message/send`/`message/stream`). `@a2a-js/sdk` не пробрасывает `configuration` в
 * `RequestContext`, поэтому читаем здесь, в express-слое (тело уже распарсено `express.json()`),
 * и кладём в ALS — executor возьмёт оттуда. Для AG-UI-тела `params` нет → `undefined`.
 */
function readAcceptedOutputModes(body: unknown): string[] | undefined {
  const params = (body as { params?: unknown } | undefined)?.params as
    | { configuration?: { acceptedOutputModes?: unknown } }
    | undefined
  const modes = params?.configuration?.acceptedOutputModes
  return Array.isArray(modes) ? modes.filter((m): m is string => typeof m === 'string') : undefined
}

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
    const acceptedOutputModes = readAcceptedOutputModes(req.body)
    try {
      const ctx = await AgentContext.fromRequest(req.headers, settings, overrides)
      requestScope.run(
        { ctx, bearer: extractBearer(req.headers), acceptedOutputModes },
        () => next(),
      )
    } catch (e) {
      if (e instanceof AuthError && required) {
        res.status(401).json({ error: 'unauthorized', detail: e.message })
        return
      }
      requestScope.run(
        { ctx: undefined, bearer: undefined, acceptedOutputModes },
        () => next(),
      )
    }
  }
}
