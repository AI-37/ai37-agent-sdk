import type { ZodRawShape } from 'zod'
import type { AgentContext } from '@ai37/agent-sdk'

/**
 * MIME ресурса MCP App — HTML-view, который хост рисует в песочнице рядом с ответом модели.
 * Спека MCP Apps 2026-01-26 (`io.modelcontextprotocol/ui`), в `@modelcontextprotocol/ext-apps`
 * это `RESOURCE_MIME_TYPE`. Держим строку у себя, чтобы не тянуть ext-apps в SDK ради константы.
 */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

/**
 * Legacy-ключ `_meta` инструмента со ссылкой на view (та же спека, `RESOURCE_URI_META_KEY` в
 * ext-apps). Хосты постарше читают только его, новые — `_meta.ui.resourceUri`; хост отдаёт оба.
 */
export const MCP_APP_RESOURCE_URI_META_KEY = 'ui/resourceUri'

/** Текстовый блок результата (`TextContent` MCP). */
export interface McpTextContent {
  type: 'text'
  text: string
}

/** Картинка в результате (`ImageContent` MCP): base64 без префикса `data:` и её MIME. */
export interface McpImageContent {
  type: 'image'
  data: string
  mimeType: string
}

/**
 * Результат одного MCP tool-вызова — подмножество `CallToolResult` MCP SDK.
 *
 * `content` — то, что видит модель; читать текст — через сужение `block.type === 'text'`.
 * `structuredContent` — JSON-результат для клиента. Осторожно: хост без UI (Claude Code) отдаёт
 * модели `structuredContent` ВМЕСТО `content`, так что большой JSON сюда класть нельзя — модель
 * получит его целиком. `_meta` модели не показывает ни один хост: это канал для view MCP App
 * (так в нём едет поток A2UI, `_meta["ai37/a2ui"]`).
 */
export interface McpToolResult {
  content: Array<McpTextContent | McpImageContent>
  isError?: boolean
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

/** Кто видит инструмент: модель (`model`), view MCP App (`app`). По умолчанию — оба. */
export type McpToolVisibility = 'model' | 'app'

/**
 * UI инструмента по MCP Apps: какой view хост рисует на его результат и кому инструмент виден.
 * `visibility: ['app']` — служебный инструмент view (кнопки формы): модель его не видит, но в
 * `tools/list` он есть — прячет его хост, а не сервер.
 */
export interface McpToolUi {
  /** `ui://…` ресурса из `McpOptions.resources`. */
  resourceUri: string
  visibility?: McpToolVisibility[]
}

/**
 * Источники, которые view разрешено трогать из песочницы (CSP хоста). Пусто — ничего: view
 * живёт на том, что принёс в себе, и на вызовах инструментов через хост.
 */
export interface McpResourceCsp {
  /** `connect-src`: fetch/XHR/WebSocket. */
  connectDomains?: string[]
  /** `img-src`/`script-src`/`style-src`/`font-src`/`media-src`. */
  resourceDomains?: string[]
  /** `frame-src`: вложенные iframe. */
  frameDomains?: string[]
  /** `base-uri`. */
  baseUriDomains?: string[]
}

/** Пожелания view к хосту: CSP песочницы и рамка вокруг (`_meta.ui` ресурса). */
export interface McpResourceUi {
  csp?: McpResourceCsp
  /** `true` — рамка и фон от хоста, `false` — без них, не задано — решает хост. */
  prefersBorder?: boolean
}

/**
 * Ресурс MCP-сервера; на практике — HTML-view MCP App (`ui://…`). `read` хост зовёт один раз на
 * процесс и дальше отдаёт запомненный текст: view приезжает в образ зависимостью и не меняется.
 */
export interface McpResourceDef {
  /** `ui://<агент>/<view>.html` — на него ссылается `McpToolDef.ui.resourceUri`. */
  uri: string
  name: string
  description?: string
  /** По умолчанию `MCP_APP_MIME_TYPE`. */
  mimeType?: string
  read: () => string | Promise<string>
  ui?: McpResourceUi
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
  /** UI по MCP Apps: view на результат и видимость. Без него инструмент такой же, как раньше. */
  ui?: McpToolUi
  /** `signal` — отмена вызова MCP-клиентом (`notifications/cancelled`) или обрыв соединения. */
  handler: (
    args: Record<string, unknown>,
    ctx: AgentContext | undefined,
    signal?: AbortSignal,
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
  /** Ресурсы сервера (view MCP App). Без них `resources/*` сервер не объявляет, как раньше. */
  resources?: McpResourceDef[]
}
