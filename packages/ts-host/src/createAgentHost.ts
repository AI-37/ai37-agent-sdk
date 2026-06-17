import express, { type Express } from 'express'
import { AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk'
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type TaskStore,
} from '@a2a-js/sdk/server'
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express'
import type { AgentContextSettings } from '@ai37/agent-sdk'
import {
  buildDevContextOverrides,
  isDevModeRequested,
} from '@ai37/agent-sdk/dev'
import { jwtGuard } from './auth-guard'
import { HostExecutor } from './a2a-executor'
import { aguiRouter } from './agui'
import type { AgentHandler } from './types'

export interface AgentHostOptions {
  /** AgentCard (discovery). */
  card: AgentCard
  /** Когниция агента (intent/work/critic/respond внутри). */
  handler: AgentHandler
  /** Настройки auth/billing для @ai37/agent-sdk AgentContext. */
  agentContext: AgentContextSettings
  /** Базовый путь A2A JSON-RPC. По умолчанию '/a2a/v1'. */
  basePath?: string
  /**
   * Каталог(и) A2UI, которые эмитит этот агент (обычно один — `CATALOG_ID` из
   * `@ai37/a2ui-catalog-schemas`). Нужен для негоциации каталога (РЕШЕНИЕ 10): surface шлётся
   * только если он есть в клиентском `supportedCatalogIds`. Не задан → агент текстовый (A2UI не шлёт).
   * Каталог также объявляется в card `capabilities.extensions[].uri` (для внешней discovery).
   */
  catalogId?: string | string[]
  /** Объект для /health и /version. */
  buildInfo?: Record<string, unknown>
  /**
   * Хранилище task'ов (multi-turn/HITL: состояние хода персистится в task.metadata
   * и возвращается в `AgentInput.taskState`). По умолчанию `InMemoryTaskStore`
   * (per-process, не переживает рестарт/реплики) — для durable передайте свой стор.
   */
  taskStore?: TaskStore
}

/**
 * Собирает HTTP-приложение агента: health/version + agent-card + A2A JSON-RPC +
 * AG-UI SSE, всё за JWT-guard'ом (verified AgentContext в request-scope).
 * Новый агент = `createAgentHost({ card, handler, agentContext })`.
 */
export function createAgentHost(opts: AgentHostOptions): Express {
  const app = express()
  app.use(express.json())

  const info = opts.buildInfo ?? {}
  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', ...info })
  })
  app.get('/api/v1/version', (_req, res) => {
    res.json(info)
  })

  // Multi-turn/HITL: состояние хода живёт в task-store (см. AgentResult.state /
  // AgentInput.taskState). По умолчанию in-memory; для durable — opts.taskStore.
  // Content-negotiation (РЕШЕНИЕ 10), две оси:
  //  - формат текста — из card.defaultOutputModes (media-типы текста) ∩ acceptedOutputModes клиента;
  //  - каталог UI — opts.catalogId ∩ supportedCatalogIds клиента.
  // Enforcement — в адаптерах (a2a-executor/agui), которым передаём оба набора.
  const agentTextModes = opts.card.defaultOutputModes ?? []
  const agentCatalogIds = opts.catalogId

  // Один стор на оба пути (A2A + AG-UI), чтобы state переживал ходы в обоих.
  const taskStore = opts.taskStore ?? new InMemoryTaskStore()

  const requestHandler = new DefaultRequestHandler(
    opts.card,
    taskStore,
    new HostExecutor(opts.handler, agentTextModes, agentCatalogIds),
  )

  app.use(
    `/${AGENT_CARD_PATH}`,
    agentCardHandler({ agentCardProvider: requestHandler }),
  )

  const required = opts.agentContext.auth.required ?? true
  // Dev-режим (insecure-dev / fake billing) включается ТОЛЬКО через env и fail-closed в проде
  // (см. @ai37/agent-sdk/dev). В обычном режиме возвращает {} → поведение не меняется.
  const devOverrides = buildDevContextOverrides()
  if (isDevModeRequested()) {
    console.warn(
      '[ai37-agent-host] ⚠️ агент запущен в DEV-режиме (insecure-dev / fake billing). ' +
        'Не использовать в проде.',
    )
  }
  const guard = jwtGuard(opts.agentContext, required, devOverrides)
  const base = opts.basePath ?? '/a2a/v1'

  app.use(
    base,
    guard,
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication, // auth делает guard (ALS)
    }),
  )

  app.use('/agui', guard, aguiRouter(opts.handler, agentTextModes, agentCatalogIds, taskStore))

  return app
}
