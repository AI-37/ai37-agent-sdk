import { v4 as uuidv4 } from 'uuid'
import { Role, TaskState, type Message, type Task } from '@a2a-js/sdk'
import { filterA2uiByCatalog, type OutputNegotiation } from './output-modes'
import { toA2uiSnapshot } from './a2ui'
import type { A2uiComponent, AgentResult } from './types'
import { dataPart, textPart } from './a2a-v1'

const now = (): string => new Date().toISOString()

/** Дефолт без негоциации: текст-only (каталог не согласован → A2UI не шлём). */
const TEXT_ONLY: OutputNegotiation = { text: 'text/plain', catalogIds: [], catalogId: null }

export function agentMessage(
  taskId: string,
  contextId: string,
  text: string,
): Message {
  return {
    messageId: uuidv4(),
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    contextId,
    taskId,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
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
  // Конверты `A2uiSnapshot` проходят ЦЕЛИКОМ (сквозной контракт lookup: relay-оркестратор кладёт их
  // в свой result.a2ui, его host эмитит с теми же id); фильтр каталога — по вложенному компоненту.
  const a2ui = (result.a2ui ?? []).filter(
    (item) => filterA2uiByCatalog([toA2uiSnapshot(item).component], negotiation).length > 0,
  )
  const followup =
    result.followup && negotiation.catalogIds.includes(result.followup.catalogId ?? negotiation.catalogId ?? '')
      ? result.followup
      : undefined

  if (result.status === 'failed') {
    return {
      id: taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_FAILED,
        message: agentMessage(taskId, contextId, result.message ?? 'Ошибка'),
        timestamp: now(),
      },
      artifacts: [],
      history: [],
      metadata: undefined,
    }
  }

  if (result.status === 'input-required') {
    return {
      id: taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        message: agentMessage(taskId, contextId, result.message ?? 'Уточните'),
        timestamp: now(),
      },
      artifacts: [],
      history: [],
      metadata: {
        a2ui: followup ? [followup] : a2ui,
        ...(result.state !== undefined ? { state: result.state } : {}),
      },
    }
  }

  return {
    id: taskId,
    contextId,
    status: {
      state: TaskState.TASK_STATE_COMPLETED,
      message: undefined,
      // Текст — только если агент его дал (компонент-онли каноничен: AG-UI content опционален,
      // A2A не требует текстовый part). Никаких болванок '.Готово'.
      ...(result.message
        ? { message: agentMessage(taskId, contextId, result.message) }
        : {}),
      timestamp: now(),
    },
    metadata: result.state !== undefined ? { state: result.state } : undefined,
    history: [],
    artifacts: [
      {
        artifactId: uuidv4(),
        name: 'result',
        description: '',
        parts: [dataPart({ a2ui, result: result.result })],
        metadata: undefined,
        extensions: [],
      },
    ],
  }
}
