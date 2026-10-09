import type { TaskStore } from '@a2a-js/sdk/server'
import { currentCallContext } from './owner'
import { TERMINAL_TASK_STATES } from './terminal-states'

/**
 * Состояние хода (`AgentResult.state`, оно же `task.metadata.state`) для REST-ручек агента вне
 * диалогового хода: протоколы, черновики форм, рекомендации по каталогу.
 *
 * Ручки работают через эти функции, а не через `taskStore.load/save` напрямую по двум причинам.
 * Первая: владелец. Задача читается и пишется от имени пользователя из JWT запроса
 * (`currentCallContext()`), поэтому чужой `taskId` даёт «нет задачи», а не чужое состояние. Вторая:
 * форма задачи. В `@a2a-js/sdk` 1.x `Task` другой (protobuf, числовые enum'ы), а ручке нужен только
 * словарь состояния. Эти функции переживут смену SDK без правок у агента.
 *
 * Вызывать внутри запроса за `jwtGuard`.
 */

/**
 * Состояние задачи `taskId` или `undefined`, если задачи нет (истекла, не создавалась или принадлежит
 * другому пользователю). Задача есть, а состояния нет — `{}`.
 */
export async function loadTaskState(
  store: TaskStore,
  taskId: string,
): Promise<Record<string, unknown> | undefined> {
  const task = await store.load(taskId, currentCallContext())
  if (!task) return undefined
  const state = task.metadata?.state
  return isRecord(state) ? state : {}
}

/**
 * Заменяет состояние задачи `taskId` целиком; остальная задача (статус, артефакты, прочие поля
 * `metadata`) не меняется. `false` — задачи нет (как у `loadTaskState`) или она уже завершена
 * (completed/failed/canceled/rejected): запись не делалась. Завершённая задача неизменяема, и
 * `Ai37TaskStore` такую запись всё равно пропустил бы.
 *
 * Чтение и запись не атомарны: параллельная запись того же `taskId` (ход и ручка одновременно)
 * перетрёт одну из правок, как и прямой `load` + `save`.
 */
export async function saveTaskState(
  store: TaskStore,
  taskId: string,
  state: Record<string, unknown>,
): Promise<boolean> {
  const context = currentCallContext()
  const task = await store.load(taskId, context)
  if (!task) return false
  if (task.status && TERMINAL_TASK_STATES.has(task.status.state)) return false
  await store.save({ ...task, metadata: { ...task.metadata, state } }, context)
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
