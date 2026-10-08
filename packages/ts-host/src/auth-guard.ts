import type { NextFunction, Request, Response } from 'express'
import {
  AgentContext,
  AuthError,
  extractBearer,
  type AgentContextOverrides,
  type AgentContextSettings,
} from '@ai37/agent-sdk'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { readClientCapabilities } from './output-modes'
import { requestScope } from './als'
import { recordAuthFailure, recordAuthGuardError } from './metrics'

/**
 * Достаёт нативный `params.configuration.acceptedOutputModes` (формат текста) из тела A2A JSON-RPC
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
 * Достаёт `a2uiClientCapabilities.v0.9.supportedCatalogIds` (каталоги A2UI) из метаданных A2A-
 * сообщения (`params.message.metadata`) — канонный носитель негоциации каталога. Для AG-UI-тела
 * `params` нет → []; там capabilities читаются роутером из `forwardedProps`.
 */
function readSupportedCatalogIds(body: unknown): string[] | undefined {
  const metadata = (body as { params?: { message?: { metadata?: unknown } } } | undefined)?.params
    ?.message?.metadata
  const ids = readClientCapabilities(metadata)
  return ids.length > 0 ? ids : undefined
}

/**
 * Достаёт `metadata.ai37.instructions` (жёсткая политика владельца) из A2A-сообщения
 * (`params.message.metadata.ai37`). Для AG-UI-тела `params` нет → undefined (там инструкцию в scope
 * кладёт роутер из forwardedProps). Пустая строка → undefined.
 */
function readInstructions(body: unknown): string | undefined {
  const ai37 = (
    body as
      | { params?: { message?: { metadata?: { ai37?: { instructions?: unknown } } } } }
      | undefined
  )?.params?.message?.metadata?.ai37
  const raw = typeof ai37?.instructions === 'string' ? ai37.instructions.trim() : ''
  return raw || undefined
}

/**
 * Сбой проверки при `required=true`, не являющийся `AuthError`: конфиг (`BillingConfigurationError`
 * при пустом `appsAuthToken`), зависимость (introspection/JWKS вне обёртки `AuthError`) или баг.
 * Запрос завершаем, а не пропускаем анонимом: иначе дыра в конфиге открывает агент без auth
 * (fail-open). Клиенту — 503 без деталей, детали — в лог и метрику
 * `ai37_agent_auth_guard_errors_total`. Общий для `jwtGuard` и `mcpChallengeGuard`.
 */
export function reportGuardError(service: string, guard: 'jwt' | 'mcp', e: unknown): void {
  recordAuthGuardError(service)
  const name = e instanceof Error ? e.name : typeof e
  const message = e instanceof Error ? e.message : String(e)
  console.error(
    `[ai37-agent-host] ${guard}-guard: проверка запроса упала не на auth (${name}: ${message}) — ` +
      'запрос отклонён 503, проверьте конфигурацию auth/billing агента.',
  )
}

/**
 * Express-middleware: строит verified `AgentContext` из заголовков и открывает
 * request-scope. При `required`: невалидный/отсутствующий токен (`AuthError`) → 401, любой другой
 * сбой проверки (конфиг, недоступная зависимость) → 503; в обоих случаях `next()` не вызывается
 * (fail-closed). При `required=false` — пропускает без ctx (миграция).
 *
 * `overrides` (verifier/billingClient) — точка внедрения dev-режима
 * (`buildDevContextOverrides` из `@ai37/agent-sdk/dev`); по умолчанию пусто → прод-поведение.
 *
 * `checkpointer` (опц.) — host-предоставленный LangGraph-saver: кладём его в turn-scope, чтобы
 * когниция агента взяла его через `currentCheckpointer()` (единая точка обоих путей — A2A и AG-UI
 * идут через guard). Не задан → в scope undefined (агент строит граф без durable-состояния).
 */
export function jwtGuard(
  settings: AgentContextSettings,
  required: boolean,
  overrides: AgentContextOverrides = {},
  service: string = 'unknown',
  checkpointer?: BaseCheckpointSaver,
) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const acceptedOutputModes = readAcceptedOutputModes(req.body)
    const supportedCatalogIds = readSupportedCatalogIds(req.body)
    const instructions = readInstructions(req.body)
    let ctx: AgentContext | undefined
    try {
      ctx = await AgentContext.fromRequest(req.headers, settings, overrides)
    } catch (e) {
      if (required) {
        if (e instanceof AuthError) {
          recordAuthFailure(service)
          res.status(401).json({ error: 'unauthorized', detail: e.message })
        } else {
          reportGuardError(service, 'jwt', e)
          res.status(503).json({ error: 'auth_unavailable' })
        }
        return
      }
      // required=false (миграция) — пропускаем без ctx.
    }
    // next() вне try: исключение ниже по цепочке не должно попасть в catch проверки и
    // запустить обработчик второй раз.
    requestScope.run(
      {
        ctx,
        bearer: ctx ? extractBearer(req.headers) : undefined,
        acceptedOutputModes,
        supportedCatalogIds,
        instructions,
        checkpointer,
      },
      () => next(),
    )
  }
}
