import { Router, type Request, type Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { EventEncoder } from '@ag-ui/encoder'
import { EventType, type BaseEvent } from '@ag-ui/core'
import { negotiateOutput, readClientCapabilities } from '@ai37/agent-sdk'
import { currentCtx, requestScope } from './als'
import { componentToA2uiOperations } from './a2ui'
import type { AgentHandler, AgentInput, Ai37Metadata, A2uiComponent } from './types'

/**
 * AG-UI SSE-адаптер (канон). Эмитит каноничные AG-UI-события через `@ag-ui/encoder`,
 * совместимые с `@ag-ui/client` HttpAgent (CopilotKit v2): RUN_STARTED → TEXT_MESSAGE_* →
 * ACTIVITY_SNAPSHOT (`a2ui-surface`) → RUN_FINISHED/RUN_ERROR.
 *
 * Готовый A2UI (`AgentResult.a2ui` / `emit({type:'a2ui'})`) отдаётся как activity-сообщение
 * `a2ui-surface` с `content.a2ui_operations` (v0.9) — рендерится CopilotKit нативно через
 * ai37Catalog. Tool-call `render_a2ui` НЕ используем (он в CopilotKit для LLM-генерации UI).
 */
type RunAgentInputLike = {
  threadId?: string
  runId?: string
  messages?: Array<{ role?: string; content?: unknown }>
  forwardedProps?: Record<string, unknown>
}

/** Текст последнего сообщения пользователя (content = string | [{type:'text', text}]). */
function lastUserText(messages?: Array<{ role?: string; content?: unknown }>): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
        .join('')
    }
  }
  return undefined
}

/** Собирает metadata.ai37 из forwardedProps (canonical AG-UI). */
function extractAi37(body: RunAgentInputLike): Ai37Metadata {
  const fp = (body.forwardedProps ?? {}) as Record<string, unknown>
  const ai37: Ai37Metadata = { ...((fp.ai37 ?? {}) as Ai37Metadata) }
  if (!ai37.thread_id) {
    if (typeof fp.thread_id === 'string') ai37.thread_id = fp.thread_id
    else if (body.threadId) ai37.thread_id = body.threadId
  }
  return ai37
}

export function aguiRouter(
  handler: AgentHandler,
  agentTextModes: string[] = [],
  agentCatalogIds?: string | string[],
): Router {
  const r = Router()
  const encoder = new EventEncoder()

  r.post('/', async (req: Request, res: Response) => {
    res.setHeader('Content-Type', encoder.getContentType())
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const emitEvent = (event: Record<string, unknown>): void => {
      res.write(encoder.encodeSSE(event as unknown as BaseEvent))
    }

    const ctx = currentCtx()
    const body = (req.body ?? {}) as RunAgentInputLike
    const threadId = body.threadId ?? uuidv4()
    const runId = body.runId ?? uuidv4()

    const metadata = extractAi37(body)
    // content-negotiation (две оси) для AG-UI (нативных A2A-полей нет):
    //  - формат текста — forwardedProps.ai37.acceptedOutputModes;
    //  - каталог — forwardedProps.a2uiClientCapabilities.v0.9.supportedCatalogIds.
    const accepted = metadata.acceptedOutputModes
    const supportedCatalogIds = readClientCapabilities(body.forwardedProps)
    const negotiation = negotiateOutput({
      acceptedOutputModes: accepted,
      agentTextModes,
      supportedCatalogIds,
      agentCatalogIds,
    })
    // Симметрия с A2A-путём: кладём обе оси в ALS, чтобы downstream (напр. оркестратор, форвардящий
    // вниз через `currentAcceptedOutputModes`/`currentSupportedCatalogIds`) видел их как `currentBearer`.
    // Guard уже открыл scope; для AG-UI-тела он пуст (нет `params`), дополняем.
    const scope = requestScope.getStore()
    if (scope) {
      scope.acceptedOutputModes = accepted
      if (supportedCatalogIds.length > 0) scope.supportedCatalogIds = supportedCatalogIds
    }

    const input: AgentInput = {
      text: lastUserText(body.messages),
      data: (body.forwardedProps?.data as Record<string, unknown>) ?? {},
      metadata,
      claims: ctx?.claims,
      billingOrgId: ctx?.billingOrgId,
      taskId: threadId,
      contextId: threadId,
      negotiation,
      ...(accepted !== undefined ? { acceptedOutputModes: accepted } : {}),
      ...(supportedCatalogIds.length > 0 ? { supportedCatalogIds } : {}),
    }

    // Готовый A2UI -> activity `a2ui-surface`. Enforcement (РЕШЕНИЕ 10): эмитим ТОЛЬКО если каталог
    // согласован (`negotiation.catalogId`); catalogId — из негоциации. Иначе — no-op (агент даёт текст).
    const emitA2ui = (component: A2uiComponent): void => {
      if (!negotiation.catalogId) return
      const surfaceId = `surf-${uuidv4()}`
      emitEvent({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: uuidv4(),
        activityType: 'a2ui-surface',
        content: {
          a2ui_operations: componentToA2uiOperations(component, {
            surfaceId,
            catalogId: negotiation.catalogId,
          }),
        },
        replace: true,
      })
    }

    let textMessageId: string | undefined
    const ensureTextStart = (): string => {
      if (!textMessageId) {
        textMessageId = uuidv4()
        emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: textMessageId, role: 'assistant' })
      }
      return textMessageId
    }

    try {
      emitEvent({ type: EventType.RUN_STARTED, threadId, runId })

      const result = await handler.run({
        input,
        ctx,
        emit: (e) => {
          if (e.type === 'text') {
            const id = ensureTextStart()
            emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: e.delta })
          } else if (e.type === 'a2ui') {
            emitA2ui(e.component)
          }
          // 'node' — внутренняя телеметрия агента; в AG-UI не пробрасываем.
        },
      })

      if (textMessageId) {
        emitEvent({ type: EventType.TEXT_MESSAGE_END, messageId: textMessageId })
      } else if (result.message) {
        // Финальный текст, если он не стримился во время run.
        const id = uuidv4()
        emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' })
        emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: result.message })
        emitEvent({ type: EventType.TEXT_MESSAGE_END, messageId: id })
      }

      for (const c of result.a2ui ?? []) emitA2ui(c)
      if (result.followup) emitA2ui(result.followup)

      if (result.status === 'failed') {
        emitEvent({ type: EventType.RUN_ERROR, message: result.message ?? 'failed' })
      } else {
        emitEvent({ type: EventType.RUN_FINISHED, threadId, runId })
      }
    } catch (e) {
      emitEvent({ type: EventType.RUN_ERROR, message: String(e) })
    } finally {
      res.end()
    }
  })

  return r
}
