import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server'
import { negotiateOutput } from '@ai37/agent-sdk'
import { currentCtx, currentAcceptedOutputModes } from './als'
import { parseA2AMessage } from './parse'
import { toTask } from './build-task'
import type { AgentHandler, AgentInput, AgentResult } from './types'

/**
 * A2A-адаптер host'а: парсит сообщение → вызывает `AgentHandler` с verified
 * `AgentContext` (из ALS) → публикует `Task`. Когниции не содержит.
 *
 * `agentSupportedModes` — что агент умеет отдавать (agent-card `defaultOutputModes`),
 * нужно для content-negotiation вывода (РЕШЕНИЕ 10).
 */
export class HostExecutor implements AgentExecutor {
  constructor(
    private readonly handler: AgentHandler,
    private readonly agentSupportedModes: string[] = [],
  ) {}

  async execute(
    rc: RequestContext,
    bus: ExecutionEventBus,
  ): Promise<void> {
    const ctx = currentCtx()
    const parsed = parseA2AMessage(rc)
    // content-negotiation: accepted берётся из нативного A2A `configuration` (через ALS, см. guard).
    const accepted = currentAcceptedOutputModes()
    const negotiation = negotiateOutput(accepted, this.agentSupportedModes)
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
