import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server'
import { negotiateOutput } from '@ai37/agent-sdk'
import {
  currentCtx,
  currentAcceptedOutputModes,
  currentSupportedCatalogIds,
} from './als'
import { parseA2AMessage } from './parse'
import { toTask } from './build-task'
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
      ...(accepted !== undefined ? { acceptedOutputModes: accepted } : {}),
      ...(supportedCatalogIds !== undefined ? { supportedCatalogIds } : {}),
      ...(priorState !== undefined ? { taskState: priorState } : {}),
    }

    let result: AgentResult
    try {
      result = await this.handler.run({ input, ctx, emit: () => {} })
    } catch (e) {
      result = { status: 'failed', message: `INTERNAL: ${String(e)}` }
    }

    // Enforcement: A2UI в Task только если клиент запросил A2UI-mode (иначе — только текст).
    bus.publish(toTask(result, rc.taskId, rc.contextId, negotiation))
    bus.finished()
  }

  cancelTask = async (): Promise<void> => {}
}
