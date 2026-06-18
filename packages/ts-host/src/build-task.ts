import { v4 as uuidv4 } from 'uuid'
import type { Message, Task } from '@a2a-js/sdk'
import { filterA2uiByCatalog, type OutputNegotiation } from './output-modes'
import type { A2uiComponent, AgentResult } from './types'

const now = (): string => new Date().toISOString()

/** Дефолт без негоциации: текст-only (каталог не согласован → A2UI не шлём). */
const TEXT_ONLY: OutputNegotiation = { text: 'text/plain', catalogIds: [], catalogId: null }

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
 * вывода (РЕШЕНИЕ 10, две оси): A2UI (включая HITL-карточку `followup`) — только если каталог
 * согласован (`negotiation.catalogId`); текст для `completed` — только если агент дал `message`
 * (никаких дефолтов). По умолчанию (без negotiation) — text-only.
 */
export function toTask(
  result: AgentResult,
  taskId: string,
  contextId: string,
  negotiation: OutputNegotiation = TEXT_ONLY,
): Task {
  // A2UI отдаётся только для согласованных каталогов (per-component роутинг); иначе пусто (агент даёт текст).
  // Компоненты остаются СЫРЫМИ деревьями (`{component, props, children?, catalogId?}`) — уплощение в
  // операции делает потребитель через `componentToA2uiOperations` (так оркестратор может пробросить их выше).
  const a2ui = filterA2uiByCatalog<A2uiComponent>(result.a2ui, negotiation)
  const followup =
    result.followup && negotiation.catalogIds.includes(result.followup.catalogId ?? negotiation.catalogId ?? '')
      ? result.followup
      : undefined

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
      // Текст — только если агент его дал (компонент-онли каноничен: AG-UI content опционален,
      // A2A не требует текстовый part). Никаких болванок '.Готово'.
      ...(result.message
        ? { message: agentMessage(taskId, contextId, result.message) }
        : {}),
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
