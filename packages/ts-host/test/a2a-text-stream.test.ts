import { describe, expect, it, vi } from 'vitest'
import { Role, TaskState, type StreamResponse, type TaskArtifactUpdateEvent } from '@a2a-js/sdk'
import type { AgentExecutionEvent, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import type { Client } from '@a2a-js/sdk/client'
import { HostExecutor } from '../src/a2a-executor'
import { executeRemoteA2aStreaming } from '../src/relay/execute'

vi.mock('../src/observability/langfuse', () => ({
  withTurnObservability: async (_context: unknown, run: () => Promise<unknown>) => run(),
  injectTraceContext: () => ({}),
}))

const userMessage = {
  messageId: 'user-1', contextId: 'chat-stream', taskId: '', role: Role.ROLE_USER,
  parts: [{ content: { $case: 'text' as const, value: 'question' }, metadata: undefined, filename: '', mediaType: '' }],
  metadata: undefined, extensions: [], referenceTaskIds: [],
}
const requestContext = {
  taskId: 'task-stream',
  contextId: 'chat-stream',
  userMessage,
  request: { tenant: '', message: userMessage, configuration: undefined, metadata: undefined },
} as unknown as RequestContext

const text = (value: string) => ({ content: { $case: 'text', value }, metadata: undefined, filename: '', mediaType: '' })

/**
 * artifact-update стрима ответа (`answer-<taskId>`). В 1.x событие — обёртка `{ kind, data }`; финал
 * хода после прогресса тоже идёт artifact-update (`result`), его здесь не считаем.
 */
function artifactUpdates(events: AgentExecutionEvent[]): TaskArtifactUpdateEvent[] {
  return events.flatMap((e) =>
    e.kind === 'artifactUpdate' && e.data.artifact?.artifactId.startsWith('answer-') ? [e.data] : [],
  )
}

function testBus() {
  const events: AgentExecutionEvent[] = []
  const finished = vi.fn()
  const bus = { publish: (event: typeof events[number]) => events.push(event), finished } as unknown as ExecutionEventBus
  return { bus, events, finished }
}

describe('native A2A answer stream', () => {
  it('publishes actual deltas before completion and closes the artifact once', async () => {
    const { bus, events, finished } = testBus()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const executor = new HostExecutor({
      async run({ emit }) {
        emit({ type: 'text', delta: '' })
        emit({ type: 'text', delta: 'first ' })
        await gate
        emit({ type: 'text', delta: 'second' })
        return { status: 'completed', message: 'first second' }
      },
    })
    const execution = executor.execute(requestContext, bus)
    await vi.waitFor(() => expect(artifactUpdates(events).filter((event) => event.append)).toHaveLength(1))
    expect(finished).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({
      kind: 'task',
      data: { id: 'task-stream', status: { state: TaskState.TASK_STATE_WORKING } },
    })
    release()
    await execution

    const artifacts = artifactUpdates(events)
    expect(artifacts.map((event) => [event.append, event.lastChunk, event.artifact?.parts])).toEqual([
      [false, false, []],
      [true, false, [text('first ')]],
      [true, false, [text('second')]],
      [true, true, []],
    ])
    expect(new Set(artifacts.map((event) => event.artifact?.artifactId)).size).toBe(1)
    expect(finished).toHaveBeenCalledOnce()

    // Те же события глазами клиента 1.x: StreamResponse с payload.$case = kind события.
    const deltas: string[] = []
    const client = {
      async *sendMessageStream() {
        for (const event of events) yield { payload: { $case: event.kind, value: event.data } } as StreamResponse
      },
    } as unknown as Client
    const result = await executeRemoteA2aStreaming(client, { query: 'question' }, (event) => {
      if (event.type === 'text') deltas.push(event.value)
    })
    expect(deltas).toEqual(['first ', 'second'])
    expect(result.text).toBe(deltas.join(''))
    expect(result.state).toBe('completed')
  })

  it('closes a partial stream and preserves failure without an answer retry', async () => {
    const { bus, events, finished } = testBus()
    await new HostExecutor({
      async run({ emit }) {
        emit({ type: 'text', delta: 'partial' })
        throw new Error('provider disconnected')
      },
    }).execute(requestContext, bus)
    // Стрим ответа закрыт, финал после прогресса — status-update (второй task в стриме 1.x запрещён).
    expect(artifactUpdates(events).at(-1)).toMatchObject({ append: true, lastChunk: true })
    expect(events.at(-1)).toMatchObject({
      kind: 'statusUpdate',
      data: { status: { state: TaskState.TASK_STATE_FAILED } },
    })
    expect(events.filter((event) => event.kind === 'task')).toHaveLength(1)
    expect(finished).toHaveBeenCalledOnce()
  })

  it('does not mint an answer artifact for non-text agents', async () => {
    const { bus, events } = testBus()
    await new HostExecutor({
      async run({ emit }) {
        emit({ type: 'node', node: 'work' })
        emit({ type: 'reasoning', delta: 'checking' })
        emit({ type: 'text', delta: '' })
        emit({ type: 'tool', phase: 'start', name: 'lookup' })
        return { status: 'completed', message: 'final' }
      },
    }).execute(requestContext, bus)
    expect(artifactUpdates(events)).toEqual([])
    // две вехи прогресса + финальный status-update
    expect(events.filter((event) => event.kind === 'statusUpdate')).toHaveLength(3)
    expect(events.at(-1)).toMatchObject({
      kind: 'statusUpdate',
      data: { status: { state: TaskState.TASK_STATE_COMPLETED, message: { parts: [text('final')] } } },
    })
  })

  it('keeps simultaneous executions live and their answer artifacts independent', async () => {
    const first = testBus()
    const second = testBus()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const executor = new HostExecutor({
      async run({ input, emit }) {
        emit({ type: 'text', delta: input.taskId })
        await gate
        return { status: 'completed', message: input.taskId }
      },
    })
    const executions = [
      executor.execute(requestContext, first.bus),
      executor.execute({ ...requestContext, taskId: 'task-other', contextId: 'chat-other' } as RequestContext, second.bus),
    ]
    try {
      await vi.waitFor(() => {
        for (const { events, finished } of [first, second]) {
          expect(artifactUpdates(events).filter((event) => event.append)).toHaveLength(1)
          expect(finished).not.toHaveBeenCalled()
        }
      })
    } finally {
      release()
      await Promise.all(executions)
    }
    for (const [index, { events }] of [first, second].entries()) {
      const taskId = index === 0 ? 'task-stream' : 'task-other'
      const chunks = artifactUpdates(events)
      expect(chunks).toHaveLength(3)
      expect(chunks.every((event) => event.artifact?.artifactId === `answer-${taskId}`)).toBe(true)
      expect(chunks[1].artifact?.parts).toEqual([text(taskId)])
      expect(chunks[2].lastChunk).toBe(true)
    }
  })
})
