import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server'
import { currentCtx } from './als'
import { parseA2AMessage } from './parse'
import { toTask } from './build-task'
import type { AgentHandler, AgentInput, AgentResult } from './types'

/**
 * A2A-адаптер host'а: парсит сообщение → вызывает `AgentHandler` с verified
 * `AgentContext` (из ALS) → публикует `Task`. Когниции не содержит.
 */
export class HostExecutor implements AgentExecutor {
  constructor(private readonly handler: AgentHandler) {}

  async execute(
    rc: RequestContext,
    bus: ExecutionEventBus,
  ): Promise<void> {
    const ctx = currentCtx()
    const parsed = parseA2AMessage(rc)
    const input: AgentInput = {
      text: parsed.text,
      data: parsed.data,
      metadata: parsed.metadata,
      claims: ctx?.claims,
      billingOrgId: ctx?.billingOrgId,
      taskId: rc.taskId,
      contextId: rc.contextId,
    }

    let result: AgentResult
    try {
      result = await this.handler.run({ input, ctx, emit: () => {} })
    } catch (e) {
      result = { status: 'failed', message: `INTERNAL: ${String(e)}` }
    }

    bus.publish(toTask(result, rc.taskId, rc.contextId))
    bus.finished()
  }

  cancelTask = async (): Promise<void> => {}
}
