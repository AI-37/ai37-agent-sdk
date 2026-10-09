import express, { type Express } from 'express'
import { AGENT_CARD_PATH } from '@a2a-js/sdk'
import {
  InMemoryTaskStore,
  type TaskStore,
} from '@a2a-js/sdk/server'
import { jsonRpcHandler } from '@a2a-js/sdk/server/express'
import type { AgentContextSettings } from '@ai37/agent-sdk'
import {
  buildDevContextOverrides,
  isDevModeRequested,
} from '@ai37/agent-sdk/dev'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { toPublicAgentCard, toSdkAgentCard, type Ai37AgentCardInput } from './agent-card'
import { hostUserBuilder } from './owner'
import { HostRequestHandler } from './request-handler'
import { legacyBlockingDefault, legacyStreamErrorsAsSse } from './legacy-stream-errors'
import { jwtGuard } from './auth-guard'
import { HostExecutor } from './a2a-executor'
import { aguiRouter } from './agui'
import { mountMcp } from './mcp/mount'
import type { McpOptions } from './mcp/types'
import type { AgentHandler } from './types'
import { renderMetrics, metricsContentType, serviceLabel } from './metrics'

export interface AgentHostOptions {
  /**
   * Карточка агента (discovery) в словаре хоста: поля A2A 0.3 + `x-ai37`. Из неё хост строит
   * карточку 1.x для обработчика SDK и публичную гибридную (0.3-поля + `supportedInterfaces`
   * с JSON-RPC 1.0 и 0.3), которую отдаёт своим роутом.
   */
  card: Ai37AgentCardInput
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
  /**
   * LangGraph-чекпоинтер (durable графовое состояние по `thread_id`) — ДРУГОЙ уровень, чем
   * `taskStore` (тот держит состояние хода/HITL в `task.metadata`). Host кладёт saver в turn-scope,
   * а когниция агента забирает его через `currentCheckpointer()` и цепляет в свой граф
   * (`graph.compile({ checkpointer })` / deepagents). Собирается фабрикой `createCheckpointer(...)`.
   * Не задан → `currentCheckpointer()` вернёт undefined (агент строит граф без durable-состояния).
   */
  checkpointer?: BaseCheckpointSaver
  /**
   * Принимать ли на A2A-эндпоинте клиентов протокола 0.3 (compat-слой `@a2a-js/sdk`). По умолчанию
   * `true`: на 0.3 ещё chat-backend до своего перехода, MCP-агрегатор и внешние клиенты. Запрос без
   * заголовка `A2A-Version` или с `0.3` уходит в compat, с `1.0` — в обработчик 1.x. Выключать после
   * перевода последнего внутреннего клиента (план docs#465, решение 8). Вместе с compat выключается и
   * копия формы `input-required` в артефакте `a2ui-<taskId>` (её читает только relay 0.3).
   */
  legacyCompat?: boolean
  /**
   * «Экспорт» агента как MCP Resource Server: монтирует `/mcp` (StreamableHTTP) +
   * protected-resource-metadata (OAuth-discovery на Authentik) за тем же токен-guard'ом,
   * что A2A/AG-UI. `tools` — статический список ИЛИ per-request резолвер (для per-user
   * наборов). Не задан → MCP-эндпоинт не монтируется (поведение агента не меняется).
   */
  mcp?: McpOptions
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

  // Prometheus-метрики хоста. ВНЕ jwtGuard: скрейпит внутрикластерный Alloy, порт агента не на
  // публичном Ingress. service-лейбл фиксирован на процесс (из card.name) → низкая кардинальность.
  const service = serviceLabel(opts.card.name)
  app.get('/metrics', async (_req, res) => {
    try {
      res.setHeader('Content-Type', metricsContentType)
      res.end(await renderMetrics())
    } catch {
      res.status(500).end()
    }
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

  const legacyCompat = opts.legacyCompat ?? true
  const requestHandler = new HostRequestHandler(
    toSdkAgentCard(opts.card, { legacyCompat }),
    taskStore,
    new HostExecutor(opts.handler, agentTextModes, agentCatalogIds, service, legacyCompat),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // Шина события задачи закрывается сразу после хода, и на input-required тоже. По умолчанию SDK
    // держит её живой ради resubscribe к паузе, которого у нас нет; брошенная пауза HITL оставила
    // бы шину в памяти процесса навсегда. Продолжение паузы открывает новую шину.
    { keepBusAliveStates: [] },
  )

  // Карточка своим роутом, а не agentCardHandler SDK: см. toPublicAgentCard (x-ai37 + 1.0-интерфейсы).
  const publicCard = toPublicAgentCard(opts.card, { legacyCompat })
  app.get(`/${AGENT_CARD_PATH}`, (_req, res) => {
    res.json(publicCard)
  })

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
  const guard = jwtGuard(
    opts.agentContext,
    required,
    devOverrides,
    service,
    opts.checkpointer,
  )
  const base = opts.basePath ?? '/a2a/v1'

  app.use(
    base,
    guard,
    // Клиенту 0.3: ошибка до первого события стрима — событием SSE, как у сервера 0.3;
    // `message/send` без `blocking` — блокирующий, как у сервера 0.3.
    ...(legacyCompat ? [legacyStreamErrorsAsSse, legacyBlockingDefault] : []),
    jsonRpcHandler({
      requestHandler,
      // JWT проверяет guard (ALS), здесь только владелец задачи `<org_id>:<sub>` для TaskStore.
      // Compat-трафик 0.3 идёт через тот же userBuilder.
      userBuilder: hostUserBuilder,
      legacyCompat: { enabled: legacyCompat },
    }),
  )

  app.use('/agui', guard, aguiRouter(opts.handler, agentTextModes, agentCatalogIds, taskStore, service))

  // «Экспорт» MCP (опционально): /mcp + protected-resource-metadata за тем же verified auth.
  // Отдельный challenge-guard (RFC 9728: 401 + WWW-Authenticate), а не общий jwtGuard.
  if (opts.mcp) {
    mountMcp(app, {
      card: opts.card,
      mcp: opts.mcp,
      agentContext: opts.agentContext,
      required,
      overrides: devOverrides,
      buildInfo: info,
      service,
    })
  }

  return app
}
