// Конструкторы объектов A2A 1.x (protobuf-типы @a2a-js/sdk) для тестов: у них все поля обязательны.
import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Part,
  type StreamResponse,
  type Task,
  type TaskArtifactUpdateEvent,
  type TaskStatusUpdateEvent,
} from '@a2a-js/sdk'

export const text = (value: string): Part => ({
  content: { $case: 'text', value },
  metadata: undefined,
  filename: '',
  mediaType: '',
})

export const data = (value: unknown): Part => ({
  content: { $case: 'data', value },
  metadata: undefined,
  filename: '',
  mediaType: '',
})

export function agentMsg(value: string, ...extra: Part[]): Message {
  return {
    messageId: 'm',
    contextId: 'c',
    taskId: 't',
    role: Role.ROLE_AGENT,
    parts: [text(value), ...extra],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

export function artifact(artifactId: string, parts: Part[], name = ''): Artifact {
  return { artifactId, name, description: '', parts, metadata: undefined, extensions: [] }
}

export function task(
  id: string,
  state: TaskState,
  opts: { contextId?: string; message?: Message; artifacts?: Artifact[]; metadata?: Record<string, unknown> } = {},
): Task {
  return {
    id,
    contextId: opts.contextId ?? 'c',
    status: { state, message: opts.message, timestamp: '0' },
    artifacts: opts.artifacts ?? [],
    history: [],
    metadata: opts.metadata,
  }
}

export function statusUpdate(
  taskId: string,
  state: TaskState,
  metadata?: Record<string, unknown>,
): StreamResponse {
  const value: TaskStatusUpdateEvent = {
    taskId,
    contextId: 'c',
    status: { state, message: undefined, timestamp: '0' },
    metadata,
  }
  return { payload: { $case: 'statusUpdate', value } }
}

export function artifactUpdate(taskId: string, art: Artifact, append = false): StreamResponse {
  const value: TaskArtifactUpdateEvent = {
    taskId,
    contextId: 'c',
    artifact: art,
    append,
    lastChunk: false,
    metadata: undefined,
  }
  return { payload: { $case: 'artifactUpdate', value } }
}

export const taskEvent = (value: Task): StreamResponse => ({ payload: { $case: 'task', value } })

export { Role, TaskState }
