import { v4 as uuidv4 } from 'uuid'
import type { Message, Task } from '@a2a-js/sdk'
import { filterA2uiComponents, type OutputNegotiation } from '@ai37/agent-sdk'
import type { A2uiComponent, AgentResult } from './types'

const now = (): string => new Date().toISOString()

/** Текст эмитится всегда; A2UI — только когда клиент запросил A2UI-mode. */
const TEXT_ONLY: OutputNegotiation = { text: 'text/plain', a2ui: false }

export function agentMessage(
  taskId: string,
  contextId: string,
  text: string,
): Message {
  return {
    kind: 'message',
    messageId: uuidv4(),
    role: 'agent',
    parts: [{ kind: 'text', text }],
    contextId,
    taskId,
  }
}

/**
 * Заворачивает результат handler'а в A2A-`Task`. `negotiation` определяет content-negotiation
 * вывода (РЕШЕНИЕ 10): текст — всегда, A2UI (включая HITL-карточку `followup`) — только если
 * клиент запросил A2UI-mode. По умолчанию (без negotiation) — text-only.
 */
export function toTask(
  result: AgentResult,
  taskId: string,
  contextId: string,
  negotiation: OutputNegotiation = TEXT_ONLY,
): Task {
  // A2UI отдаётся только при явном запросе; иначе пустой список (дефолт — текст).
  const a2ui = filterA2uiComponents<A2uiComponent>(result.a2ui, negotiation)
  const followup = negotiation.a2ui ? result.followup : undefined

  if (result.status === 'failed') {
    return {
      kind: 'task',
      id: taskId,
      contextId,
      status: {
        state: 'failed',
        message: agentMessage(taskId, contextId, result.message ?? 'Ошибка'),
        timestamp: now(),
      },
    }
  }

  if (result.status === 'input-required') {
    return {
      kind: 'task',
      id: taskId,
      contextId,
      status: {
        state: 'input-required',
        message: agentMessage(taskId, contextId, result.message ?? 'Уточните'),
        timestamp: now(),
      },
      metadata: {
        a2ui: followup ? [followup] : a2ui,
        ...(result.state !== undefined ? { state: result.state } : {}),
      },
    }
  }

  return {
    kind: 'task',
    id: taskId,
    contextId,
    status: {
      state: 'completed',
      message: agentMessage(taskId, contextId, result.message ?? 'Готово'),
      timestamp: now(),
    },
    ...(result.state !== undefined ? { metadata: { state: result.state } } : {}),
    artifacts: [
      {
        artifactId: uuidv4(),
        name: 'result',
        parts: [
          {
            kind: 'data',
            data: { a2ui, result: result.result },
          },
        ],
      },
    ],
  }
}
