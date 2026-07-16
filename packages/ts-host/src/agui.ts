import { Router, type Request, type Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { EventEncoder } from '@ag-ui/encoder'
import { EventType, type BaseEvent } from '@ag-ui/core'
import type { TaskStore } from '@a2a-js/sdk/server'
import { negotiateOutput, readClientCapabilities } from './output-modes'
import { currentCtx, requestScope } from './als'
import { componentToA2uiOperations, toA2uiSnapshot } from './a2ui'
import { toTask } from './build-task'
import { withTurnObservability } from './observability/langfuse'
import type {
  AgentEvent,
  AgentHandler,
  AgentInput,
  Ai37Metadata,
  A2uiComponent,
  A2uiAction,
  A2uiDataPatch,
} from './types'

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
  /**
   * Прочее из клиента (`data`, `ai37`, `a2uiClientCapabilities`) + A2UI-действие
   * (`a2uiAction.userAction` — клик кнопки/submit, канон ACTIVITY_SNAPSHOT).
   */
  forwardedProps?: Record<string, unknown> & {
    a2uiAction?: {
      userAction?: {
        name?: unknown
        context?: unknown
        surfaceId?: unknown
        sourceComponentId?: unknown
      }
    }
  }
}

/**
 * A2UI-действие из `forwardedProps.a2uiAction.userAction` (канон ACTIVITY_SNAPSHOT):
 * юзер нажал кнопку/submit → `{name, context, surfaceId?, sourceComponentId?}`.
 * undefined, если действия нет (обычный текстовый ход) или `name` не строка.
 */
function readA2uiAction(forwardedProps?: RunAgentInputLike['forwardedProps']): A2uiAction | undefined {
  const ua = forwardedProps?.a2uiAction?.userAction
  if (!ua || typeof ua.name !== 'string') return undefined
  const action: A2uiAction = {
    name: ua.name,
    context: (ua.context as Record<string, unknown> | undefined) ?? {},
  }
  if (typeof ua.surfaceId === 'string') action.surfaceId = ua.surfaceId
  if (typeof ua.sourceComponentId === 'string') action.sourceComponentId = ua.sourceComponentId
  return action
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
  taskStore?: TaskStore,
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
      // Инструкция владельца (жёсткая политика) в scope — Ai37ChatCompletions подмешает её в LLM-вызовы.
      if (typeof metadata.instructions === 'string' && metadata.instructions.trim()) {
        scope.instructions = metadata.instructions.trim()
      }
    }

    // Multi-turn/HITL: состояние прошлого хода thread'а из task-store
    // (taskId = threadId). undefined на первом ходу. Симметрично A2A-пути.
    const priorTask = taskStore ? await taskStore.load(threadId) : undefined
    const priorState = priorTask?.metadata?.state as
      | Record<string, unknown>
      | undefined

    // A2UI-действие (клик/submit) из forwardedProps.a2uiAction — канон ACTIVITY_SNAPSHOT.
    const action = readA2uiAction(body.forwardedProps)

    const input: AgentInput = {
      text: lastUserText(body.messages),
      data: (body.forwardedProps?.data as Record<string, unknown>) ?? {},
      metadata,
      claims: ctx?.claims,
      billingOrgId: ctx?.billingOrgId,
      taskId: threadId,
      contextId: threadId,
      negotiation,
      ...(action ? { action } : {}),
      ...(accepted !== undefined ? { acceptedOutputModes: accepted } : {}),
      ...(supportedCatalogIds.length > 0 ? { supportedCatalogIds } : {}),
      ...(priorState !== undefined ? { taskState: priorState } : {}),
    }

    // Готовый A2UI -> activity `a2ui-surface`. Enforcement (РЕШЕНИЕ 10) + роутинг (A): каталог surface —
    // тег компонента (`component.catalogId`) либо первичный согласованный; эмитим ТОЛЬКО если он в
    // согласованном множестве (`negotiation.catalogIds`). Иначе — no-op (агент даёт текст/другой каталог).
    // `messageId`/`surfaceId` из события — стабильные id (lookup-канал: клиент заменяет
    // activity-сообщение по `messageId` на месте); не заданы → random, прежнее поведение.
    const emitA2ui = (e: {
      component: A2uiComponent
      messageId?: string
      surfaceId?: string
      dataModel?: A2uiDataPatch[]
    }): void => {
      const catalogId = e.component.catalogId ?? negotiation.catalogId
      if (!catalogId || !negotiation.catalogIds.includes(catalogId)) return
      const surfaceId = e.surfaceId ?? `surf-${uuidv4()}`
      emitEvent({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: e.messageId ?? uuidv4(),
        activityType: 'a2ui-surface',
        content: {
          a2ui_operations: componentToA2uiOperations(e.component, {
            surfaceId,
            catalogId,
            ...(e.dataModel ? { dataModel: e.dataModel } : {}),
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

    // Reasoning/COT → нативные AG-UI `REASONING_*` (CopilotKit рисует встроенную сворачивающуюся
    // карточку «Thinking…» → «Thought for Ns»). Ленивое открытие блока (как ensureTextStart):
    // REASONING_START (id блока) + REASONING_MESSAGE_START (id текста, role:'reasoning'), затем дельты.
    let reasoningBlockId: string | undefined
    let reasoningMessageId: string | undefined
    const ensureReasoningStart = (): string => {
      if (!reasoningMessageId) {
        reasoningBlockId = uuidv4()
        reasoningMessageId = uuidv4()
        emitEvent({ type: EventType.REASONING_START, messageId: reasoningBlockId })
        emitEvent({ type: EventType.REASONING_MESSAGE_START, messageId: reasoningMessageId, role: 'reasoning' })
      }
      return reasoningMessageId
    }
    const emitReasoning = (delta: string): void => {
      const id = ensureReasoningStart()
      emitEvent({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: id, delta })
    }
    /** Закрыть открытый reasoning-блок (перед финальным текстом / RUN_FINISHED). Идемпотентно. */
    const endReasoning = (): void => {
      if (reasoningMessageId) {
        emitEvent({ type: EventType.REASONING_MESSAGE_END, messageId: reasoningMessageId })
        emitEvent({ type: EventType.REASONING_END, messageId: reasoningBlockId })
        reasoningMessageId = undefined
        reasoningBlockId = undefined
      }
    }

    // Tool-call → нативные `TOOL_CALL_*` (CopilotKit рисует статус-карточку через DefaultToolCallRenderer).
    const emitTool = (e: Extract<AgentEvent, { type: 'tool' }>): void => {
      const id = e.id ?? `tc-${uuidv4()}`
      if (e.phase === 'start') {
        emitEvent({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: e.name })
        if (e.args !== undefined) {
          emitEvent({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify(e.args) })
        }
      } else {
        emitEvent({ type: EventType.TOOL_CALL_END, toolCallId: id })
        if (e.result !== undefined) {
          const content = typeof e.result === 'string' ? e.result : JSON.stringify(e.result)
          emitEvent({ type: EventType.TOOL_CALL_RESULT, messageId: uuidv4(), toolCallId: id, content, role: 'tool' })
        }
      }
    }

    try {
      emitEvent({ type: EventType.RUN_STARTED, threadId, runId })

      // Langfuse v4: открываем turn-спан `agui-turn` (sessionId=contextId=threadId) и делаем его
      // активным OTel-контекстом на время когниции → LangChain-спаны нестятся под него, исходящие
      // A2A-вызовы форвардят его traceparent. No-op, если трассировка выключена. trace_id фронта
      // (input/forwardedProps.ai37.trace_id) наследуется как id трейса.
      const result = await withTurnObservability(
        {
          contextId: threadId,
          taskId: threadId,
          claims: ctx?.claims,
          metadata,
          text: input.text,
          billingOrgId: ctx?.billingOrgId,
          agentName: 'agui-turn',
        },
        () =>
          handler.run({
            input,
            ctx,
            emit: (e) => {
              if (e.type === 'text') {
                // НЕ закрываем reasoning здесь: агенты (напр. rag-factory за sub-agent-релеем) могут
                // перемежать reasoning/node с текстом в рамках ОДНОГО хода (несколько раундов
                // planner/search, ответ-генератор с interleaved cot/answer-чанками). Закрытие тут
                // эагерли на первом text-тике заставляло ensureReasoningStart() открыть ВТОРОЙ,
                // независимый REASONING-блок при возврате reasoning — вторая «Thinking…»-карточка
                // на один логический ход. Единственное закрытие — endReasoning() ниже, по факту
                // завершения run()/ошибки. На видимость это не влияет: CopilotChatReasoningMessage
                // считает isStreaming по isLatest (последнее ли это сообщение), а не по факту
                // REASONING_END — карточка сворачивается в «Thought for Ns», как только появляется
                // более новое (текстовое) сообщение, независимо от момента формального закрытия.
                const id = ensureTextStart()
                emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: e.delta })
              } else if (e.type === 'a2ui') {
                emitA2ui(e)
              } else if (e.type === 'reasoning') {
                emitReasoning(e.delta)
              } else if (e.type === 'node') {
                // back-compat: имя ноды агента вливаем строкой в reasoning-карточку.
                emitReasoning(`▸ ${e.node}\n`)
              } else if (e.type === 'tool') {
                emitTool(e)
              }
            },
          }),
        (r) => ({ status: r.status, message: r.message }),
      )

      // Закрываем reasoning-блок до финального текста/завершения хода (если ещё открыт).
      endReasoning()

      // Персистим состояние хода в task-store (multi-turn/HITL). Тот же формат
      // и тот же taskId(=threadId), что на A2A-пути → state переживает ходы.
      if (taskStore) {
        await taskStore.save(toTask(result, threadId, threadId, negotiation))
      }

      if (textMessageId) {
        emitEvent({ type: EventType.TEXT_MESSAGE_END, messageId: textMessageId })
      } else if (result.message) {
        // Финальный текст, если он не стримился во время run.
        const id = uuidv4()
        emitEvent({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' })
        emitEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: result.message })
        emitEvent({ type: EventType.TEXT_MESSAGE_END, messageId: id })
      }

      for (const item of result.a2ui ?? []) emitA2ui(toA2uiSnapshot(item))
      if (result.followup) emitA2ui({ component: result.followup })

      if (result.status === 'failed') {
        emitEvent({ type: EventType.RUN_ERROR, message: result.message ?? 'failed' })
      } else {
        emitEvent({ type: EventType.RUN_FINISHED, threadId, runId })
      }
    } catch (e) {
      endReasoning()
      emitEvent({ type: EventType.RUN_ERROR, message: String(e) })
    } finally {
      // Langfuse-батч уже досослан внутри `withTurnObservability` (forceFlush на закрытии turn-спана).
      res.end()
    }
  })

  return r
}
