import { describe, it, expect } from 'vitest'
import type { Client } from '@a2a-js/sdk/client'
import type { Message, Task } from '@a2a-js/sdk'
import { executeRemoteA2a } from '../src/relay/index'

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
