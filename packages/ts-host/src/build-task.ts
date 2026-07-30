import { v4 as uuidv4 } from 'uuid'
import type { Message, Task } from '@a2a-js/sdk'
import { filterA2uiByCatalog, type OutputNegotiation } from './output-modes'
import { toA2uiSnapshot } from './a2ui'
import type { A2uiComponent, A2uiSnapshot, AgentResult } from './types'

const now = (): string => new Date().toISOString()

/**
 * Инвариант a2ui-action-owner-by-surface: каждый `input-required` элемент A2UI уезжает КОНВЕРТОМ
 * `A2uiSnapshot` с `surfaceId` — оркестратор строит по нему durable-маппинг «surface →
 * агент-владелец» и маршрутизирует сабмит формы именно её владельцу. Сырое дерево (включая
 * `followup` — путь elevator'а) нормализуется в конверт; дефолт id выводится из taskId: стабилен
 * между шагами ОДНОГО визарда (resume того же таска) и уникален между визардами/повторными
 * запусками в диалоге (новый запуск = новый таск). Заданные агентом id не трогаются (сквозной
 * контракт lookup/in-place replace).
 */
function ensureEnvelopeSurfaceIds(
  items: (A2uiComponent | A2uiSnapshot)[],
  taskId: string,
): A2uiSnapshot[] {
  let minted = 0
  return items.map((item) => {
    const envelope = toA2uiSnapshot(item)
    if (envelope.surfaceId) return envelope
    minted += 1
    return { ...envelope, surfaceId: minted === 1 ? `surf-${taskId}` : `surf-${taskId}-${minted}` }
  })
}

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
        // Формы уезжают конвертами с гарантированным surfaceId (см. ensureEnvelopeSurfaceIds).
        a2ui: ensureEnvelopeSurfaceIds(followup ? [followup] : a2ui, taskId),
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
