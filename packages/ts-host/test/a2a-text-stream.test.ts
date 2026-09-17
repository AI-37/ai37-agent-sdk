import { describe, expect, it, vi } from 'vitest'
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import type { Client } from '@a2a-js/sdk/client'
import { HostExecutor } from '../src/a2a-executor'
import { executeRemoteA2aStreaming } from '../src/relay/execute'

vi.mock('../src/observability/langfuse', () => ({
  withTurnObservability: async (_context: unknown, run: () => Promise<unknown>) => run(),
  injectTraceContext: () => ({}),
}))

const requestContext = {
  taskId: 'task-stream',
  contextId: 'chat-stream',
  userMessage: {
    kind: 'message', messageId: 'user-1', role: 'user',
    parts: [{ kind: 'text', text: 'question' }],
  },
} as RequestContext

function testBus() {
  const events: Parameters<ExecutionEventBus['publish']>[0][] = []
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
    await vi.waitFor(() => expect(events.filter((event) => event.kind === 'artifact-update' && event.append)).toHaveLength(1))
    expect(finished).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({ kind: 'task', id: 'task-stream', status: { state: 'working' } })
    release()
    await execution

    const artifacts = events.filter((event) => event.kind === 'artifact-update')
    expect(artifacts.map((event) => [event.append, event.lastChunk, event.artifact.parts])).toEqual([
      [false, false, []],
      [true, false, [{ kind: 'text', text: 'first ' }]],
      [true, false, [{ kind: 'text', text: 'second' }]],
      [true, true, []],
    ])
    expect(new Set(artifacts.map((event) => event.artifact.artifactId)).size).toBe(1)
    expect(finished).toHaveBeenCalledOnce()

    const deltas: string[] = []
    const client = {
      async *sendMessageStream() { for (const event of events) yield event },
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
    expect(events.at(-2)).toMatchObject({ kind: 'artifact-update', append: true, lastChunk: true })
    expect(events.at(-1)).toMatchObject({ kind: 'task', status: { state: 'failed' } })
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
    expect(events.filter((event) => event.kind === 'artifact-update')).toEqual([])
    expect(events.filter((event) => event.kind === 'status-update')).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ status: { message: { parts: [{ kind: 'text', text: 'final' }] } } })
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
      executor.execute({ ...requestContext, taskId: 'task-other', contextId: 'chat-other' }, second.bus),
    ]
    try {
      await vi.waitFor(() => {
        for (const { events, finished } of [first, second]) {
          expect(events.filter((event) => event.kind === 'artifact-update' && event.append)).toHaveLength(1)
          expect(finished).not.toHaveBeenCalled()
        }
      })
    } finally {
      release()
      await Promise.all(executions)
    }
    for (const [index, { events }] of [first, second].entries()) {
      const taskId = index === 0 ? 'task-stream' : 'task-other'
      const chunks = events.filter((event) => event.kind === 'artifact-update')
      expect(chunks).toHaveLength(3)
      expect(chunks.every((event) => event.artifact.artifactId === `answer-${taskId}`)).toBe(true)
      expect(chunks[1].artifact.parts).toEqual([{ kind: 'text', text: taskId }])
      expect(chunks[2].lastChunk).toBe(true)
    }
  })
})
