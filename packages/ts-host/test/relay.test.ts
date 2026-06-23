import { describe, it, expect } from 'vitest'
import type { Client } from '@a2a-js/sdk/client'
import type { Message, Task } from '@a2a-js/sdk'
import {
  executeRemoteA2a,
  executeRemoteA2aStreaming,
  type RemoteA2aProgressEvent,
} from '../src/relay/index'

/** Фейковый A2A Client: запоминает params, отдаёт заранее заданный результат (или бросает). */
function fakeClient(
  handler: (params: unknown, callIndex: number) => Message | Task,
): { client: Client; calls: unknown[] } {
  const calls: unknown[] = []
  const client = {
    sendMessage: (params: unknown) => {
      const i = calls.length
      calls.push(params)
      return Promise.resolve(handler(params, i))
    },
  } as unknown as Client
  return { client, calls }
}

function inputRequiredTaskWithForm(taskId: string): Task {
  return {
    kind: 'task',
    id: taskId,
    contextId: 'ctx-1',
    status: { state: 'input-required', message: undefined, timestamp: '0' },
    metadata: { a2ui: [{ component: 'FormCard', props: { title: 'T' } }] },
  } as unknown as Task
}

describe('executeRemoteA2a (relay)', () => {
  it('форвардит action вниз в message.metadata.a2uiAction.userAction', async () => {
    const { client, calls } = fakeClient(() => inputRequiredTaskWithForm('task-1'))
    await executeRemoteA2a(client, {
      query: 'submit',
      contextId: 'ctx-1',
      resumeTaskId: 'task-1',
      action: { name: 'apply', context: { N: '13' } },
      supportedCatalogIds: ['cat-1'],
      acceptedOutputModes: ['text/markdown'],
      contextRefs: ['ref-1'],
    })
    const p = calls[0] as { message: { metadata: Record<string, any>; taskId?: string }; configuration?: any }
    expect(p.message.metadata.a2uiAction.userAction).toEqual({ name: 'apply', context: { N: '13' } })
    expect(p.message.metadata.a2uiClientCapabilities['v0.9'].supportedCatalogIds).toEqual(['cat-1'])
    expect(p.message.metadata.ai37.context_refs).toEqual(['ref-1'])
    expect(p.message.taskId).toBe('task-1')
    expect(p.configuration.acceptedOutputModes).toEqual(['text/markdown'])
  })

  it('поднимает A2UI-форму из task.metadata.a2ui + taskId + state', async () => {
    const { client } = fakeClient(() => inputRequiredTaskWithForm('task-9'))
    const res = await executeRemoteA2a(client, { query: 'hi', contextId: 'ctx-1' })
    expect(res.state).toBe('input-required')
    expect(res.taskId).toBe('task-9')
    expect(res.a2ui).toHaveLength(1)
    expect((res.a2ui[0] as any).component).toBe('FormCard')
    expect(res.staleResumeDropped).toBe(false)
  })

  it('устаревший resume-таск → повтор без taskId, staleResumeDropped=true', async () => {
    const { client, calls } = fakeClient((_p, i) => {
      if (i === 0) throw { code: -32001, message: 'Task not found' }
      return inputRequiredTaskWithForm('task-new')
    })
    const res = await executeRemoteA2a(client, {
      query: 'submit',
      contextId: 'ctx-1',
      resumeTaskId: 'stale-task',
      action: { name: 'apply', context: {} },
    })
    expect(res.staleResumeDropped).toBe(true)
    expect(res.taskId).toBe('task-new')
    expect(calls).toHaveLength(2)
    // первый запрос нёс resume-taskId, второй — нет
    expect((calls[0] as any).message.taskId).toBe('stale-task')
    expect((calls[1] as any).message.taskId).toBeUndefined()
  })

  it('без action/негоциации — message.metadata отсутствует', async () => {
    const { client, calls } = fakeClient(() => inputRequiredTaskWithForm('t'))
    await executeRemoteA2a(client, { query: 'hi' })
    expect((calls[0] as any).message.metadata).toBeUndefined()
  })
})

/** Фейковый стрим-Client: sendMessageStream отдаёт заранее заданную последовательность событий. */
function fakeStreamClient(events: unknown[]): { client: Client; calls: unknown[] } {
  const calls: unknown[] = []
  const client = {
    sendMessageStream: (params: unknown) => {
      calls.push(params)
      return (async function* () {
        for (const e of events) yield e
      })()
    },
  } as unknown as Client
  return { client, calls }
}

describe('executeRemoteA2aStreaming (relay стрим)', () => {
  it('форвардит node/reasoning из status-update.metadata и собирает финальный Task', async () => {
    const completedTask: Task = {
      kind: 'task',
      id: 'task-s1',
      contextId: 'ctx-1',
      status: { state: 'completed', timestamp: '1' },
      artifacts: [
        {
          artifactId: 'a1',
          parts: [
            { kind: 'text', text: 'итог' },
            { kind: 'data', data: { a2ui: [{ component: 'SimpleTable', props: {} }] } },
          ],
        },
      ],
    } as unknown as Task

    const { client } = fakeStreamClient([
      { kind: 'task', id: 'task-s1', contextId: 'ctx-1', status: { state: 'working', timestamp: '0' }, history: [] },
      { kind: 'status-update', taskId: 'task-s1', contextId: 'ctx-1', status: { state: 'working' }, final: false, metadata: { 'ai37/node': 'intent' } },
      { kind: 'status-update', taskId: 'task-s1', contextId: 'ctx-1', status: { state: 'working' }, final: false, metadata: { 'ai37/reasoning': 'разбираю данные…' } },
      { kind: 'status-update', taskId: 'task-s1', contextId: 'ctx-1', status: { state: 'working' }, final: false, metadata: { 'ai37/node': 'work' } },
      completedTask,
    ])

    const seen: RemoteA2aProgressEvent[] = []
    const res = await executeRemoteA2aStreaming(client, { query: 'hi', contextId: 'ctx-1' }, (e) => seen.push(e))

    expect(seen).toEqual([
      { type: 'node', value: 'intent' },
      { type: 'reasoning', value: 'разбираю данные…' },
      { type: 'node', value: 'work' },
    ])
    expect(res.state).toBe('completed')
    expect(res.taskId).toBe('task-s1')
    expect(res.text).toBe('итог')
    expect(res.a2ui).toHaveLength(1)
    expect((res.a2ui[0] as any).component).toBe('SimpleTable')
  })

  it('накапливает artifact-update (append) в финальный Task', async () => {
    const { client } = fakeStreamClient([
      { kind: 'task', id: 't2', contextId: 'c', status: { state: 'working' }, artifacts: [] },
      { kind: 'artifact-update', taskId: 't2', contextId: 'c', artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'часть1 ' }] } },
      { kind: 'artifact-update', taskId: 't2', contextId: 'c', append: true, artifact: { artifactId: 'a', parts: [{ kind: 'text', text: 'часть2' }] } },
      { kind: 'status-update', taskId: 't2', contextId: 'c', status: { state: 'completed' }, final: true },
    ])
    const res = await executeRemoteA2aStreaming(client, { query: 'hi' }, () => {})
    expect(res.text).toBe('часть1 часть2')
    expect(res.state).toBe('completed')
  })
})
