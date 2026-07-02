import { randomUUID } from 'node:crypto'
import type { ZodRawShape } from 'zod'
import { negotiateOutput } from '../output-modes'
import type { AgentHandler, AgentResult } from '../types'
import type { McpToolDef } from './types'

export interface BridgeToolOptions {
  /** Имя MCP-tool (напр. `calc_lifts`). */
  name: string
  /** Описание для внешней LLM — что делает и что передавать в `query`. */
  description: string
  /** Zod raw shape входа; по умолчанию `{ query: string }`. */
  inputSchema?: ZodRawShape
  /** Форматы текста агента (обычно `card.defaultOutputModes`) — для негоциации текста. */
  textModes?: string[]
  /** Кастомный рендер `AgentResult` → текст (по умолчанию `message`, иначе JSON(`result`)). */
  renderResult?: (result: AgentResult) => string
}

/** Текст ответа по умолчанию: приоритет `message`, затем структурный `result`, затем статус. */
function defaultRender(result: AgentResult): string {
  if (result.message) return result.message
  if (result.result !== undefined) {
    return typeof result.result === 'string'
      ? result.result
      : JSON.stringify(result.result, null, 2)
  }
  return result.status === 'failed' ? 'Ошибка выполнения' : 'Готово'
}

/**
 * Оборачивает когницию A2A-агента (`AgentHandler`) в одноразовый MCP-tool: собирает `AgentInput`
 * из аргумента `query`, зовёт `handler.run` (с verified `ctx` — билинг/claims сохраняются) и
 * возвращает текст ответа. Зеркало import-стороны, где внешний A2A-агент оборачивается в
 * LangChain-tool со схемой `{query}`. Диалоговость схлопывается: один вызов = один прогон
 * intent→work→critic→respond (без persistence между вызовами — потребитель передаёт всё в `query`).
 */
export function bridgeHandlerToMcpTool(
  handler: AgentHandler,
  opts: BridgeToolOptions,
): McpToolDef {
  return {
    name: opts.name,
    description: opts.description,
    ...(opts.inputSchema ? { inputSchema: opts.inputSchema } : {}),
    handler: async (args, ctx) => {
      const query =
        typeof args.query === 'string' ? args.query : JSON.stringify(args)
      const id = randomUUID()
      // MCP — текстовый транспорт: A2UI не негоциируем (пустой набор каталогов клиента).
      const negotiation = negotiateOutput({
        acceptedOutputModes: undefined,
        agentTextModes: opts.textModes,
        supportedCatalogIds: [],
        agentCatalogIds: undefined,
      })
      const result = await handler.run({
        input: {
          text: query,
          data: {},
          metadata: {},
          claims: ctx?.claims,
          billingOrgId: ctx?.billingOrgId,
          taskId: id,
          contextId: id,
          negotiation,
        },
        ctx,
        emit: () => {},
      })
      const text = opts.renderResult
        ? opts.renderResult(result)
        : defaultRender(result)
      return {
        content: [{ type: 'text', text }],
        isError: result.status === 'failed',
      }
    },
  }
}
