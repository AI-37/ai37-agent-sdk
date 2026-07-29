import {
  Role,
  TaskState,
  type Message,
  type Part,
  type Task,
} from '@a2a-js/sdk'

export function textPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  }
}

export function dataPart(data: unknown): Part {
  return {
    content: { $case: 'data', value: data },
    metadata: undefined,
    filename: '',
    mediaType: 'application/json',
  }
}

export function partText(part: Part): string | undefined {
  if (part.content?.$case === 'text') return part.content.value
  const legacy = part as unknown as { kind?: string; text?: unknown }
  return legacy.kind === 'text' && typeof legacy.text === 'string'
    ? legacy.text
    : undefined
}

export function partData(part: Part): unknown {
  if (part.content?.$case === 'data') return part.content.value
  const legacy = part as unknown as { kind?: string; data?: unknown }
  return legacy.kind === 'data' ? legacy.data : undefined
}

export function isTask(value: Message | Task): value is Task {
  return 'id' in value && 'status' in value
}

export function isMessage(value: Message | Task): value is Message {
  return 'messageId' in value && 'parts' in value
}

export function userMessage(args: {
  messageId: string
  parts: Part[]
  contextId?: string
  taskId?: string
  metadata?: Record<string, unknown>
}): Message {
  return {
    messageId: args.messageId,
    role: Role.ROLE_USER,
    parts: args.parts,
    contextId: args.contextId ?? '',
    taskId: args.taskId ?? '',
    metadata: args.metadata,
    extensions: [],
    referenceTaskIds: [],
  }
}

export function remoteState(
  state: TaskState | 'completed' | 'input-required' | 'failed' | undefined,
): 'completed' | 'input-required' | 'failed' | undefined {
  if (state === TaskState.TASK_STATE_COMPLETED || state === 'completed') return 'completed'
  if (state === TaskState.TASK_STATE_INPUT_REQUIRED || state === 'input-required') {
    return 'input-required'
  }
  if (state === TaskState.TASK_STATE_FAILED || state === 'failed') return 'failed'
  return undefined
}
