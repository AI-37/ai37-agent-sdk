import { v4 as uuidv4 } from 'uuid'
import type { Message, Task } from '@a2a-js/sdk'
import type { AgentResult } from './types'

const now = (): string => new Date().toISOString()

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

/** Заворачивает результат handler'а в A2A-`Task`. */
export function toTask(
  result: AgentResult,
  taskId: string,
  contextId: string,
): Task {
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
        a2ui: result.followup ? [result.followup] : (result.a2ui ?? []),
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
    artifacts: [
      {
        artifactId: uuidv4(),
        name: 'result',
        parts: [
          {
            kind: 'data',
            data: { a2ui: result.a2ui ?? [], result: result.result },
          },
        ],
      },
    ],
  }
}
