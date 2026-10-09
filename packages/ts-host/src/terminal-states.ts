import { TaskState } from '@a2a-js/sdk'

/** Состояния, из которых A2A-задача уже не выходит (как `TERMINAL_STATE_LIST` обработчика SDK). */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
])
