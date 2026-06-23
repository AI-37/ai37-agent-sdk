import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentContext } from '@ai37/agent-sdk'

/**
 * Request-scope: JWT-guard кладёт сюда verified `AgentContext`, executor/handler
 * читают, не завязываясь на внутренний auth-API `@a2a-js/sdk`.
 */
export interface HostScope {
  ctx?: AgentContext
  bearer?: string
  /**
   * `acceptedOutputModes` (формат текста) из нативного A2A `params.configuration`.
   * Guard читает его из тела JSON-RPC в express-слое, т.к. `@a2a-js/sdk` НЕ пробрасывает
   * `configuration` в `RequestContext` исполнителя. На AG-UI-пути дополняется роутером из
   * `forwardedProps.ai37.acceptedOutputModes`.
   */
  acceptedOutputModes?: string[]
  /**
   * `supportedCatalogIds` (каталоги A2UI) из `a2uiClientCapabilities.v0.9` — для A2A из
   * `message.metadata`, для AG-UI из `forwardedProps.a2uiClientCapabilities`. В ALS, чтобы
   * downstream (оркестратор → remote-агенты) форвардил их так же, как `currentBearer`.
   */
  supportedCatalogIds?: string[]
  /**
   * Per-turn Langfuse-наблюдаемость (трейс хода + LangChain `CallbackHandler`). Заполняется
   * executor'ом/AG-UI-роутером через `beginTurnObservability` ДО вызова handler'а, поэтому
   * когниция агента может прокинуть `currentLangfuseCallbacks()` в LangChain `invoke`, не зная
   * про Langfuse. Типы намеренно `unknown` — чтобы ts-host не тянул @langchain/core в сборку.
   */
  langfuse?: HostLangfuseScope
}

/** Срез Langfuse одного хода (см. observability/langfuse.ts). */
export interface HostLangfuseScope {
  /** Стабильный id трейса (из `metadata.ai37.trace_id` клиента либо сгенерированный). */
  traceId: string
  /** `LangfuseTraceClient` (типизирован `unknown` — фактический тип в langfuse.ts). */
  trace: unknown
  /** LangChain `CallbackHandler` (langfuse-langchain), привязанный к корневому трейсу. */
  handler?: unknown
}

export const requestScope = new AsyncLocalStorage<HostScope>()

export const currentCtx = (): AgentContext | undefined =>
  requestScope.getStore()?.ctx

export const currentBearer = (): string | undefined =>
  requestScope.getStore()?.bearer

export const currentAcceptedOutputModes = (): string[] | undefined =>
  requestScope.getStore()?.acceptedOutputModes

export const currentSupportedCatalogIds = (): string[] | undefined =>
  requestScope.getStore()?.supportedCatalogIds

/**
 * Стабильный id Langfuse-трейса текущего хода (или undefined, если трассировка выключена).
 * Совпадает с `metadata.ai37.trace_id`, который прислал клиент, — поэтому фронт может позже
 * привязать к нему пользовательскую оценку (`langfuseWeb.score`), не получая id обратно.
 */
export const currentTraceId = (): string | undefined =>
  requestScope.getStore()?.langfuse?.traceId

/** `LangfuseTraceClient` текущего хода (типизирован `unknown`) — для ручных span'ов/score из агента. */
export const currentLangfuseTrace = (): unknown =>
  requestScope.getStore()?.langfuse?.trace

/**
 * LangChain `CallbackHandler` (langfuse-langchain) текущего хода или undefined. Прокидывается
 * агентом в `model.invoke(input, { callbacks: [currentLangfuseHandler()] })`.
 */
export const currentLangfuseHandler = (): unknown =>
  requestScope.getStore()?.langfuse?.handler

/**
 * Готовый массив callbacks для LangChain: `[handler]` если трассировка включена, иначе `[]`.
 * Эргономичная форма: `invoke(input, { callbacks: currentLangfuseCallbacks() })`.
 */
export const currentLangfuseCallbacks = (): unknown[] => {
  const h = requestScope.getStore()?.langfuse?.handler
  return h ? [h] : []
}
