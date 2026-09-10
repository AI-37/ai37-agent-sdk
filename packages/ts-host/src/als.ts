import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentContext } from '@ai37/agent-sdk'
// `import type` — тип стирается при сборке, поэтому als.ts НЕ тянет @langchain/langgraph-checkpoint
// в рантайм (пакет — optional peer). Держит als.ts «лёгким», как и langfuse-типы (`unknown`).
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'

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
   * Постоянная инструкция владельца/партнёра (`metadata.ai37.instructions`). Host кладёт её сюда
   * из ai37 (A2A-guard + AG-UI-роутер); когниция агента дописывает её в system-промпт через
   * `withPartnerInstructions()` (видимо в трейсе). Пусто → no-op.
   */
  instructions?: string
  /**
   * Per-turn Langfuse-наблюдаемость (turn-спан + LangChain `CallbackHandler`). Заполняется
   * executor'ом/AG-UI-роутером внутри `withTurnObservability` ДО вызова handler'а, поэтому
   * когниция агента может прокинуть `currentLangfuseCallbacks()` в LangChain `invoke`, не зная
   * про Langfuse. Типы намеренно `unknown` — чтобы ts-host не тянул @langchain/core в сборку.
   */
  langfuse?: HostLangfuseScope
  /**
   * LangGraph-чекпоинтер, предоставленный ХОСТОМ (durable графовое состояние по `thread_id`).
   * Host кладёт его в scope из `AgentHostOptions.checkpointer` (через jwtGuard), а когниция агента
   * забирает через `currentCheckpointer()` и передаёт в свой граф: `graph.compile({ checkpointer })`
   * (или в deepagents). Не задан хостом → undefined (агент строит граф без durable-состояния).
   * Это ДРУГОЙ уровень, чем A2A `taskStore` (состояние хода/HITL): checkpointer — состояние графа.
   */
  checkpointer?: BaseCheckpointSaver
}

/** Срез Langfuse одного хода (см. observability/langfuse.ts). */
export interface HostLangfuseScope {
  /** Id трейса текущего хода (== `metadata.ai37.trace_id` фронта, либо унаследованный/новый). */
  traceId?: string
  /**
   * Id диалога/сессии хода (`contextId`). Это Langfuse session / `trace.v1.sessionId`,
   * НЕ путать с OTel/Langfuse trace id.
   */
  sessionId?: string
  /** Id хода (`taskId`) — `trace.v1.turnId`. */
  turnId?: string
  /** Активный turn-спан (`LangfuseSpan` v4, типизирован `unknown`) — для ручных под-спанов/score. */
  span?: unknown
  /** LangChain `CallbackHandler` (@langfuse/langchain) — нестится под активный turn-спан. */
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
 * LangGraph-чекпоинтер текущего хода, предоставленный хостом (durable графовое состояние), или
 * undefined, если host не сконфигурирован с `checkpointer` (dev/агент без durable-графа). Когниция
 * агента передаёт его в свой граф: `graph.compile({ checkpointer: currentCheckpointer() })`. Читается
 * из turn-scope (как `currentCtx()`), поэтому вне запроса вернёт undefined.
 */
export const currentCheckpointer = (): BaseCheckpointSaver | undefined =>
  requestScope.getStore()?.checkpointer

/**
 * Постоянная инструкция владельца/партнёра текущего хода (`metadata.ai37.instructions`) или
 * undefined. `Ai37ChatCompletions` читает её и подмешивает как system-directive абсолютного
 * приоритета — поэтому агенту НЕ нужно прокидывать её вручную (работает на всех агентах).
 */
export const currentPartnerInstructions = (): string | undefined =>
  requestScope.getStore()?.instructions

/**
 * Дописывает постоянную инструкцию владельца/партнёра (`currentPartnerInstructions`, из
 * `metadata.ai37.instructions`) ОТДЕЛЬНОЙ СЕКЦИЕЙ В КОНЕЦ системного промпта агента. Агент зовёт её
 * там, где строит system-сообщение для LLM: `new SystemMessage(withPartnerInstructions(basePrompt))`.
 *
 * Почему так, а не инъекцией в модель: инструкция попадает в сообщения ДО `invoke`, поэтому она
 * ВИДНА и в реальном запросе к LLM, и в Langfuse-трейсе (в отличие от подмешивания внутри
 * `_generate`, которое трассировка не показывает). Работает на всех агентах — one-liner на
 * call-site. Нет инструкции (обычно вне widget-канала) → промпт не меняется.
 */
export const withPartnerInstructions = (systemPrompt: string): string => {
  const instructions = requestScope.getStore()?.instructions?.trim()
  if (!instructions) return systemPrompt
  return `${systemPrompt}\n\n## Инструкция владельца (соблюдай в приоритете)\n${instructions}`
}

/**
 * Стабильный id Langfuse-трейса текущего хода (или undefined, если трассировка выключена).
 * Совпадает с `metadata.ai37.trace_id`, который прислал клиент, — поэтому фронт может позже
 * привязать к нему пользовательскую оценку (`langfuseWeb.score`), не получая id обратно.
 */
export const currentTraceId = (): string | undefined =>
  requestScope.getStore()?.langfuse?.traceId

/** `trace.v1.sessionId` текущего хода (= A2A `contextId` / диалог), либо undefined вне turn-scope. */
export const currentSessionId = (): string | undefined =>
  requestScope.getStore()?.langfuse?.sessionId

/** `trace.v1.turnId` текущего хода (= A2A `taskId`), либо undefined вне turn-scope. */
export const currentTurnId = (): string | undefined =>
  requestScope.getStore()?.langfuse?.turnId

/** Активный turn-спан текущего хода (`LangfuseSpan` v4, типизирован `unknown`) — для ручных под-спанов/score. */
export const currentLangfuseTrace = (): unknown =>
  requestScope.getStore()?.langfuse?.span

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
