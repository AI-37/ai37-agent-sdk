import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server'
import type { AgentEvent } from './types'
import { negotiateOutput } from './output-modes'
import {
  currentCtx,
  currentAcceptedOutputModes,
  currentSupportedCatalogIds,
} from './als'
import { parseA2AMessage } from './parse'
import { toTask } from './build-task'
import {
  beginTurnObservability,
  finishTurnObservability,
  flushTurnObservability,
} from './observability/langfuse'
import type { AgentHandler, AgentInput, AgentResult } from './types'

/**
 * A2A-адаптер host'а: парсит сообщение → вызывает `AgentHandler` с verified
 * `AgentContext` (из ALS) → публикует `Task`. Когниции не содержит.
 *
 * `agentTextModes` — текстовые форматы агента (agent-card `defaultOutputModes`);
 * `agentCatalogIds` — каталог(и) A2UI агента. Для content-negotiation вывода (РЕШЕНИЕ 10).
 */
export class HostExecutor implements AgentExecutor {
  constructor(
    private readonly handler: AgentHandler,
    private readonly agentTextModes: string[] = [],
    private readonly agentCatalogIds?: string | string[],
  ) {}

  async execute(
    rc: RequestContext,
    bus: ExecutionEventBus,
  ): Promise<void> {
    const ctx = currentCtx()
    const parsed = parseA2AMessage(rc)
    // content-negotiation (две оси): формат текста — из нативного `configuration.acceptedOutputModes`;
    // каталог — из `message.metadata.a2uiClientCapabilities.supportedCatalogIds`. Оба — через ALS (guard).
    const accepted = currentAcceptedOutputModes()
    const supportedCatalogIds = currentSupportedCatalogIds()
    const negotiation = negotiateOutput({
      acceptedOutputModes: accepted,
      agentTextModes: this.agentTextModes,
      supportedCatalogIds,
      agentCatalogIds: this.agentCatalogIds,
    })
    // Состояние прошлого хода: A2A-SDK грузит прошлый Task по message.taskId,
    // host прокидывает его в handler (server-side multi-turn/HITL).
    const priorState = (
      rc.task?.metadata as Record<string, unknown> | undefined
    )?.state as Record<string, unknown> | undefined
    const input: AgentInput = {
      text: parsed.text,
      data: parsed.data,
      metadata: parsed.metadata,
      claims: ctx?.claims,
      billingOrgId: ctx?.billingOrgId,
      taskId: rc.taskId,
      contextId: rc.contextId,
      negotiation,
      // A2UI-действие (клик/submit), форварднутое оркестратором — симметрия с AG-UI-путём.
      ...(parsed.action ? { action: parsed.action } : {}),
      ...(accepted !== undefined ? { acceptedOutputModes: accepted } : {}),
      ...(supportedCatalogIds !== undefined ? { supportedCatalogIds } : {}),
      ...(priorState !== undefined ? { taskState: priorState } : {}),
    }

    // Langfuse: открываем трейс хода (sessionId=contextId, userId=claims.sub) ДО когниции,
    // чтобы handler мог прокинуть `currentLangfuseCallbacks()` в LangChain. No-op, если выключено.
    await beginTurnObservability({
      contextId: rc.contextId,
      taskId: rc.taskId,
      claims: ctx?.claims,
      metadata: parsed.metadata,
      text: parsed.text,
      billingOrgId: ctx?.billingOrgId,
      agentName: 'a2a-turn',
    })

    // Промежуточный прогресс/COT агента → A2A `status-update` события (стримятся клиенту на
    // `message/stream`; на блокирующем `message/send` сворачиваются ResultManager'ом в финальный
    // Task — поведение прежнее). Лениво публикуем initial working-Task на ПЕРВОМ emit, чтобы у
    // status-update был совпадающий по id таск; агенты, которые ничего не эмитят, ничего лишнего
    // не публикуют (нулевое изменение поведения). Форвардим только `node`/`reasoning`
    // (text/a2ui едут в финальном Task; `tool` — событие оркестратора, не leaf-агента).
    let workingTaskStarted = false
    const emit = (e: AgentEvent): void => {
      if (e.type !== 'node' && e.type !== 'reasoning') return
      if (!workingTaskStarted) {
        workingTaskStarted = true
        bus.publish({
          kind: 'task',
          id: rc.taskId,
          contextId: rc.contextId,
          status: { state: 'working', timestamp: new Date().toISOString() },
          history: [],
          metadata: {},
        })
      }
      const metadata =
        e.type === 'node' ? { 'ai37/node': e.node } : { 'ai37/reasoning': e.delta }
      bus.publish({
        kind: 'status-update',
        taskId: rc.taskId,
        contextId: rc.contextId,
        status: { state: 'working', timestamp: new Date().toISOString() },
        final: false,
        metadata,
      })
    }

    let result: AgentResult
    try {
      result = await this.handler.run({ input, ctx, emit })
    } catch (e) {
      result = { status: 'failed', message: `INTERNAL: ${String(e)}` }
    }
    // Langfuse: дописываем выход хода в трейс и досылаем батч (handler.run ошибок не пробрасывает).
    finishTurnObservability({ status: result.status, message: result.message })
    await flushTurnObservability()

    // Enforcement: A2UI в Task только если клиент запросил A2UI-mode (иначе — только текст).
    bus.publish(toTask(result, rc.taskId, rc.contextId, negotiation))
    bus.finished()
  }

  cancelTask = async (): Promise<void> => {}
}
