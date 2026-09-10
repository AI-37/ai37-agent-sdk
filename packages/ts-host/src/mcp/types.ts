import type { ZodRawShape } from 'zod'
import type { AgentContext } from '@ai37/agent-sdk'

/**
 * Результат одного MCP tool-вызова — подмножество `CallToolResult` MCP SDK
 * (только текстовый контент + флаг ошибки; этого достаточно для наших агентов).
 */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/**
 * Хинты поведения инструмента (`ToolAnnotations` MCP-спеки) — БЕЗ `title`.
 *
 * Заголовок сюда не кладут: он живёт в `McpToolDef.title` и раскладывается в обе позиции
 * ответа `tools/list` самим хостом (см. `buildMcpServer`). Разреши мы задавать его и тут, и
 * там — получим два источника правды для одной строки, и рано или поздно они разъедутся.
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/**
 * Определение MCP-tool, экспонируемого хостом наружу. `inputSchema` — zod raw shape
 * (объект `{ имяАргумента: zodТип }`); по умолчанию `{ query: string }` (зеркало того, как
 * import-сторона оборачивает A2A-агента в LangChain-tool со схемой `{query}`). `handler`
 * получает провалидированные аргументы и verified `AgentContext` (кто вызвал) — им и делается
 * мост на когницию агента (`handler.run`) или на per-user набор инструментов.
 *
 * `title` и `annotations` — требование `ecosystem/v5/03-tool-contract.md` §2: выставленный наружу
 * инструмент это публичный API, и портал подачи Anthropic сверяет список с живым сервером,
 * блокируя инструменты без заголовка. Поэтому `title` **обязателен в типе** (§6, пункт 1).
 */
export interface McpToolDef {
  name: string
  /**
   * Человекочитаемый заголовок. Обязателен. Не повторяет `name` и не дублирует `description`:
   * `name` — машинный контракт, `title` — как инструмент называется для человека.
   */
  title: string
  description: string
  /** Хинты поведения (`readOnlyHint` / `destructiveHint` / …). Заголовок — в `title`, не здесь. */
  annotations?: McpToolAnnotations
  inputSchema?: ZodRawShape
  handler: (
    args: Record<string, unknown>,
    ctx: AgentContext | undefined,
  ) => Promise<McpToolResult> | McpToolResult
}

/**
 * Набор tools + опциональное освобождение ресурсов ПОСЛЕ запроса (ref-count кэша, закрытие
 * per-user коннектов и т.п.). Резолвер, который что-то «занимает» на запрос (напр.
 * `IntegrationToolsCache.getTools`), возвращает `release` — хост вызовет его на закрытии ответа.
 */
export interface McpToolSet {
  tools: McpToolDef[]
  release?: () => void | Promise<void>
}

/**
 * Резолвер набора tools. Либо статический список (elevator/rag — набор известен на старте),
 * либо функция per-request, получающая verified `AgentContext` — так chat-backend строит
 * НАБОР ПО ПОЛЬЗОВАТЕЛЮ из токена запроса (агрегатор его интеграций). Функция может вернуть
 * просто список ИЛИ `{ tools, release }` (если набор занимает ресурсы на время запроса).
 */
export type McpToolsResolver =
  | McpToolDef[]
  | ((
      ctx: AgentContext | undefined,
    ) => Promise<McpToolDef[] | McpToolSet> | McpToolDef[] | McpToolSet)

/** Опция `mcp` для `createAgentHost`: превращает агента в MCP Resource Server. */
export interface McpOptions {
  /** Статический список tools или per-request резолвер (для per-user наборов). */
  tools: McpToolsResolver
  /** OAuth-scopes, публикуемые в protected-resource-metadata (`scopes_supported`). */
  scopes?: string[]
  /** Имя MCP-сервера в initialize (по умолчанию — `card.name`). */
  serverName?: string
}
