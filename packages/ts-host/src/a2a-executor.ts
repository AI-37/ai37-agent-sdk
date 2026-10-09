import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server'
import { A2aProgress } from './a2a-progress'
import { negotiateOutput } from './output-modes'
import {
  currentCtx,
  currentAcceptedOutputModes,
  currentSupportedCatalogIds,
  requestScope,
} from './als'
import { parseA2AMessage } from './parse'
import { finalTaskEvents, toTask } from './build-task'
import { withTurnObservability } from './observability/langfuse'
import type { AgentHandler, AgentInput, AgentResult } from './types'
import { observeTurn, recordBillingDenied, normFinalState } from './metrics'
import { BillingExecutionDeniedError } from '@ai37/agent-sdk'

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
    private readonly service: string = 'unknown',
    /** Копия формы input-required в артефакте `a2ui-<taskId>` для relay 0.3 (= `legacyCompat` хоста). */
    private readonly legacyFormArtifact: boolean = true,
  ) {}

  async execute(
    rc: RequestContext,
    bus: ExecutionEventBus,
  ): Promise<void> {
    const startedAt = Date.now()
    const ctx = currentCtx()
    const parsed = parseA2AMessage(rc)
    // content-negotiation (две оси): формат текста — из нативного `configuration.acceptedOutputModes`
    // (в 1.x SDK отдаёт его в `rc.request`; пустой список = клиент не задал, тогда смотрим ALS guard'а);
    // каталог — из `message.metadata.a2uiClientCapabilities.supportedCatalogIds` через ALS.
    const accepted = requestedOutputModes(rc) ?? currentAcceptedOutputModes()
    const supportedCatalogIds = currentSupportedCatalogIds()
    const negotiation = negotiateOutput({
      acceptedOutputModes: accepted,
      agentTextModes: this.agentTextModes,
      supportedCatalogIds,
      agentCatalogIds: this.agentCatalogIds,
    })
    const input: AgentInput = {
      text: parsed.text,
      data: parsed.data,
      metadata: parsed.metadata,
      claims: ctx?.claims,
      billingOrgId: ctx?.billingOrgId,
      taskId: rc.taskId,
      contextId: rc.contextId,
      negotiation,
      ...optionalInputFields(rc, parsed, accepted, supportedCatalogIds),
    }

    // Диалог и ход — в ALS: publishArtifact и прочие вызовы «от имени хода» берут их оттуда.
    const scope = requestScope.getStore()
    if (scope) scope.turn = { contextId: rc.contextId, taskId: rc.taskId }

    // Progress stays native: node/reasoning → status-update, text → artifact-update.
    // The final Task retains the canonical complete message for send/persistence.
    const progress = new A2aProgress(rc.taskId, rc.contextId, bus)
    const emit = progress.emit

    // Langfuse v4: turn-спан `{service}:a2a` (slug card.name) — в UI видно, какой агент.
    // Активен на время когниции (LangChain-спаны нестятся под него).
    // `parentCarrier` из входящего сообщения → спан продолжает распределённый трейс оркестратора
    // (один трейс на всю цепочку UI→оркестратор→суб-агент). forceFlush — внутри обёртки.
    const result = await withTurnObservability<AgentResult>(
      {
        contextId: rc.contextId,
        taskId: rc.taskId,
        claims: ctx?.claims,
        metadata: parsed.metadata,
        text: parsed.text,
        billingOrgId: ctx?.billingOrgId,
        agentName: `${this.service}:a2a`,
        ...(parsed.traceCarrier ? { parentCarrier: parsed.traceCarrier } : {}),
      },
      async () => {
        try {
          return await this.handler.run({ input, ctx, emit })
        } catch (e) {
          // Классифицируем отказ биллинга ДО сворачивания — единый choke-point для всех агентов.
          if (e instanceof BillingExecutionDeniedError) recordBillingDenied(this.service, e.reason)
          // handler.run ошибок не пробрасывает наружу хода — сворачиваем в failed-результат.
          return { status: 'failed', message: `INTERNAL: ${String(e)}` } satisfies AgentResult
        }
      },
      (r) => ({ status: r.status, message: r.message }),
    )

    // RED-метрики хода (a2a): rate + errors + duration + terminal-state.
    observeTurn(this.service, 'a2a', normFinalState(result.status), (Date.now() - startedAt) / 1000)

    // Enforcement: A2UI в Task только если клиент запросил A2UI-mode (иначе — только текст).
    progress.finish()
    const final = toTask(result, rc.taskId, rc.contextId, negotiation, {
      legacyFormArtifact: this.legacyFormArtifact,
    })
    for (const event of finalTaskEvents(final, rc.task, progress.started)) bus.publish(event)
    bus.finished()
  }

  cancelTask = async (): Promise<void> => {}
}

/** `configuration.acceptedOutputModes` запроса; undefined, если клиент их не прислал. */
function requestedOutputModes(rc: RequestContext): string[] | undefined {
  const modes = rc.request.configuration?.acceptedOutputModes
  return modes && modes.length > 0 ? modes : undefined
}

/** Preserve negotiated capabilities, A2UI action and server-owned HITL state. */
function optionalInputFields(
  rc: RequestContext,
  parsed: ReturnType<typeof parseA2AMessage>,
  accepted: string[] | undefined,
  supportedCatalogIds: string[] | undefined,
): Pick<AgentInput, 'action' | 'acceptedOutputModes' | 'supportedCatalogIds' | 'taskState'> {
  // null — состояние, очищенное прошлым ходом (см. finalTaskEvents), для handler'а это «нет».
  const priorState = ((rc.task?.metadata as Record<string, unknown> | undefined)?.state ??
    undefined) as Record<string, unknown> | undefined
  return {
    ...(parsed.action ? { action: parsed.action } : {}),
    ...(accepted !== undefined ? { acceptedOutputModes: accepted } : {}),
    ...(supportedCatalogIds !== undefined ? { supportedCatalogIds } : {}),
    ...(priorState !== undefined ? { taskState: priorState } : {}),
  }
}
