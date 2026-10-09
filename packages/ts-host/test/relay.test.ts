import { describe, it, expect } from 'vitest'
import type { Client } from '@a2a-js/sdk/client'
import type { Message, Task } from '@a2a-js/sdk'
import { TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors'
import {
  executeRemoteA2a,
  executeRemoteA2aStreaming,
  isStaleTaskError,
  taskStateName,
  type RemoteA2aProgressEvent,
} from '../src/relay/index'
import {
  TaskState,
  agentMsg,
  artifact,
  artifactUpdate,
  data,
  statusUpdate,
  task,
  taskEvent,
  text,
} from './fixtures/a2a-v1'

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

/**
 * Форма input-required так, как её отдаёт ts-host ≥ 0.2 с compat 0.3: data-частью в `status.message`
 * (канон) и копией в артефакте `a2ui-<taskId>` (для relay 0.3).
 */
function inputRequiredTaskWithForm(taskId: string): Task {
  const form = [{ component: 'FormCard', props: { title: 'T' } }]
  return task(taskId, TaskState.TASK_STATE_INPUT_REQUIRED, {
    contextId: 'ctx-1',
    message: agentMsg('уточните', data({ a2ui: form })),
    artifacts: [artifact(`a2ui-${taskId}`, [data({ a2ui: form })])],
    metadata: { state: { step: 1 } },
  })
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

  it('поднимает A2UI-форму из артефакта формы + taskId + state', async () => {
    const { client } = fakeClient(() => inputRequiredTaskWithForm('task-9'))
    const res = await executeRemoteA2a(client, { query: 'hi', contextId: 'ctx-1' })
    expect(res.state).toBe('input-required')
    expect(res.taskId).toBe('task-9')
    expect(res.a2ui).toHaveLength(1)
    expect((res.a2ui[0] as any).component).toBe('FormCard')
    expect(res.staleResumeDropped).toBe(false)
  })

  it('форма из status.message и её копия в артефакте не задваиваются; текст — только текстовые части', async () => {
    const { client } = fakeClient(() => inputRequiredTaskWithForm('task-7'))
    const res = await executeRemoteA2a(client, { query: 'hi' })
    expect(res.a2ui).toEqual([{ component: 'FormCard', props: { title: 'T' } }])
    expect(res.text).toBe('уточните')
  })

  it('порядок мест формы: status.message → артефакт a2ui-<taskId> → metadata.a2ui', async () => {
    const pick = async (t: Task) => (await executeRemoteA2a(fakeClient(() => t).client, { query: 'x' })).a2ui
    const tag = (where: string) => [{ component: 'FormCard', props: { where } }]
    const all = task('t', TaskState.TASK_STATE_INPUT_REQUIRED, {
      message: agentMsg('?', data({ a2ui: tag('status') })),
      artifacts: [artifact('a2ui-t', [data({ a2ui: tag('artifact') })])],
      metadata: { a2ui: tag('metadata') },
    })
    expect(await pick(all)).toEqual(tag('status'))
    // ts-host 0.2.0 до этого PR и копия без канона: только артефакт.
    expect(await pick({ ...all, status: { ...all.status!, message: agentMsg('?') } })).toEqual(tag('artifact'))
    // ts-host 0.1.x / python-host: только metadata.
    expect(await pick({ ...all, status: { ...all.status!, message: agentMsg('?') }, artifacts: [] })).toEqual(
      tag('metadata'),
    )
  })

  it('пустая форма в status.message — это ответ «формы нет», копии не перебивают', async () => {
    const t = task('t', TaskState.TASK_STATE_INPUT_REQUIRED, {
      message: agentMsg('?', data({ a2ui: [] })),
      metadata: { a2ui: [{ component: 'Old', props: {} }] },
    })
    expect((await executeRemoteA2a(fakeClient(() => t).client, { query: 'x' })).a2ui).toEqual([])
  })

  it('A2UI результата (артефакт result) и форма из status.message собираются вместе', async () => {
    const t = task('t', TaskState.TASK_STATE_COMPLETED, {
      message: agentMsg('готово'),
      artifacts: [
        artifact('result', [data({ a2ui: [{ component: 'Table', props: {} }], result: {} })], 'result'),
        artifact('a2ui-t', []),
      ],
    })
    expect((await executeRemoteA2a(fakeClient(() => t).client, { query: 'x' })).a2ui).toEqual([
      { component: 'Table', props: {} },
    ])
  })

  it('форма в task.metadata.a2ui (агент на ts-host 0.1 / python-host) тоже поднимается', async () => {
    const legacy = task('task-8', TaskState.TASK_STATE_INPUT_REQUIRED, {
      metadata: { a2ui: [{ component: 'FormCard', props: {} }] },
    })
    const { client } = fakeClient(() => legacy)
    const res = await executeRemoteA2a(client, { query: 'hi' })
    expect(res.a2ui).toEqual([{ component: 'FormCard', props: {} }])
  })

  it('ответ сообщением (без задачи) → state=message, taskId нет', async () => {
    const { client } = fakeClient(() => agentMsg('просто ответ'))
    const res = await executeRemoteA2a(client, { query: 'hi' })
    expect(res.state).toBe('message')
    expect(res.taskId).toBeUndefined()
    expect(res.text).toBe('просто ответ')
  })

  it('запрос в форме 1.x: роль, части через $case, пустые id = «не задано», блокирующий вызов', async () => {
    const { client, calls } = fakeClient(() => inputRequiredTaskWithForm('t'))
    await executeRemoteA2a(client, {
      query: 'вопрос',
      data: { n: 1 },
      acceptedOutputModes: ['text/plain'],
    })
    const p = calls[0] as any
    expect(p.message.role).toBe(1) // Role.ROLE_USER
    expect(p.message.parts.map((x: any) => x.content)).toEqual([
      { $case: 'text', value: 'вопрос' },
      { $case: 'data', value: { n: 1 } },
    ])
    expect(p.message.contextId).toBe('')
    expect(p.message.taskId).toBe('')
    expect(p.configuration).toMatchObject({ acceptedOutputModes: ['text/plain'], returnImmediately: false })
  })

  it('устаревший resume-таск → повтор без taskId, staleResumeDropped=true', async () => {
    const { client, calls } = fakeClient((_p, i) => {
      if (i === 0) throw new TaskNotFoundError('Task not found: stale-task')
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
    expect((calls[1] as any).message.taskId).toBe('')
  })

  it('чужая ошибка не глотается: resume без повтора', async () => {
    const { client, calls } = fakeClient(() => {
      throw new UnsupportedOperationError('Streaming is not supported by the agent')
    })
    await expect(
      executeRemoteA2a(client, { query: 'x', resumeTaskId: 'task-1' }),
    ).rejects.toBeInstanceOf(UnsupportedOperationError)
    expect(calls).toHaveLength(1)
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
    const completedTask = task('task-s1', TaskState.TASK_STATE_COMPLETED, {
      artifacts: [
        artifact('a1', [text('итог'), data({ a2ui: [{ component: 'SimpleTable', props: {} }] })]),
      ],
    })

    const { client } = fakeStreamClient([
      taskEvent(task('task-s1', TaskState.TASK_STATE_WORKING)),
      statusUpdate('task-s1', TaskState.TASK_STATE_WORKING, { 'ai37/node': 'intent' }),
      statusUpdate('task-s1', TaskState.TASK_STATE_WORKING, { 'ai37/reasoning': 'разбираю данные…' }),
      statusUpdate('task-s1', TaskState.TASK_STATE_WORKING, { 'ai37/node': 'work' }),
      taskEvent(completedTask),
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
      taskEvent(task('t2', TaskState.TASK_STATE_WORKING)),
      artifactUpdate('t2', artifact('a', [text('часть1 ')])),
      artifactUpdate('t2', artifact('a', [text('часть2')]), true),
      statusUpdate('t2', TaskState.TASK_STATE_COMPLETED),
    ])
    const res = await executeRemoteA2aStreaming(client, { query: 'hi' }, () => {})
    expect(res.text).toBe('часть1 часть2')
    expect(res.state).toBe('completed')
  })

  it('финал после прогресса: форма в артефакте, state в status-update.metadata (сервер 1.x)', async () => {
    const { client } = fakeStreamClient([
      taskEvent(task('t3', TaskState.TASK_STATE_WORKING, { metadata: {} })),
      statusUpdate('t3', TaskState.TASK_STATE_WORKING, { 'ai37/node': 'ask' }),
      artifactUpdate('t3', artifact('a2ui-t3', [data({ a2ui: [{ component: 'Form', props: {}, surfaceId: 's' }] })])),
      statusUpdate('t3', TaskState.TASK_STATE_INPUT_REQUIRED, { state: { step: 2 } }),
    ])
    const res = await executeRemoteA2aStreaming(client, { query: 'hi' }, () => {})
    expect(res.state).toBe('input-required')
    expect(res.a2ui).toEqual([{ component: 'Form', props: {}, surfaceId: 's' }])
    // Как и сервер 1.x, relay сливает metadata status-update в задачу (прогресс тоже остаётся).
    expect((res.raw as Task).metadata).toMatchObject({ state: { step: 2 } })
  })

  it('устаревший resume на стриме → повтор без taskId', async () => {
    const calls: any[] = []
    const client = {
      sendMessageStream: (params: any) => {
        calls.push(params)
        return (async function* () {
          if (calls.length === 1) throw new UnsupportedOperationError('Task t is in a terminal state (3) and cannot be modified.')
          yield taskEvent(task('t-new', TaskState.TASK_STATE_COMPLETED, { message: agentMsg('ok') }))
        })()
      },
    } as unknown as Client
    const res = await executeRemoteA2aStreaming(client, { query: 'x', resumeTaskId: 't' }, () => {})
    expect(res.staleResumeDropped).toBe(true)
    expect(res.taskId).toBe('t-new')
    expect(calls.map((c) => c.message.taskId)).toEqual(['t', ''])
  })
})

describe('isStaleTaskError / taskStateName', () => {
  it('классы ошибок 1.x, код -32001 и текст 0.3', () => {
    expect(isStaleTaskError(new TaskNotFoundError('Task not found: x'))).toBe(true)
    expect(isStaleTaskError(new UnsupportedOperationError('Task x is in a terminal state (3) and cannot be modified.'))).toBe(true)
    expect(isStaleTaskError(new UnsupportedOperationError('Streaming is not supported'))).toBe(false)
    expect(isStaleTaskError({ code: -32001, message: 'whatever' })).toBe(true)
    expect(isStaleTaskError(new Error('Task abc is in a terminal state (completed) and cannot be modified.'))).toBe(true)
    expect(isStaleTaskError(new Error('network down'))).toBe(false)
  })

  it('числовое состояние 1.x → строка 0.3', () => {
    expect(taskStateName(TaskState.TASK_STATE_INPUT_REQUIRED)).toBe('input-required')
    expect(taskStateName(TaskState.TASK_STATE_COMPLETED)).toBe('completed')
    expect(taskStateName(TaskState.TASK_STATE_AUTH_REQUIRED)).toBe('auth-required')
    expect(taskStateName(TaskState.TASK_STATE_UNSPECIFIED)).toBe('unknown')
    expect(taskStateName(undefined)).toBe('unknown')
    expect(taskStateName(TaskState.UNRECOGNIZED)).toBe('unknown')
  })
})

/**
 * Контракт текста ответа: авторитет — `status.message`; text-артефакты при стриминге содержат ТОТ ЖЕ
 * ответ (живая проекция), поэтому суммировать их с ним нельзя — иначе агент, пользующийся штатным
 * A2A-стримингом, отдаёт пользователю ответ дважды.
 */
describe('extractText: текст ответа не удваивается', () => {
  const streamedTask = (statusMessageText?: string): Task =>
    task('t', TaskState.TASK_STATE_COMPLETED, {
      ...(statusMessageText ? { message: agentMsg(statusMessageText) } : {}),
      // Артефакт-стрим: тот же ответ, накопленный дельтами.
      artifacts: [artifact('response-text', [text('ответ агента')])],
    })

  it('стримящий агент: status.message + тот же текст в артефакте → ОДНА копия', async () => {
    const { client } = fakeClient(() => streamedTask('ответ агента'))
    const res = await executeRemoteA2a(client, { query: 'hi' })
    expect(res.text).toBe('ответ агента')
  })

  it('status.message авторитетнее артефакта (стрим мог разойтись со снапшотом)', async () => {
    const { client } = fakeClient(() => streamedTask('итоговый ответ'))
    const res = await executeRemoteA2a(client, { query: 'hi' })
    expect(res.text).toBe('итоговый ответ')
  })

  it('нет терминального текста (агент отдал только стрим) → берём артефакты', async () => {
    const { client } = fakeClient(() => streamedTask(undefined))
    const res = await executeRemoteA2a(client, { query: 'hi' })
    expect(res.text).toBe('ответ агента')
  })

  it('агент на createAgentHost: текст в status.message, артефакты только data → ОДНА копия', async () => {
    const hostStyleTask = task('t', TaskState.TASK_STATE_COMPLETED, {
      message: agentMsg('расчёт готов'),
      artifacts: [artifact('result', [data({ a2ui: [], result: { x: 1 } })])],
    })
    const { client } = fakeClient(() => hostStyleTask)
    const res = await executeRemoteA2a(client, { query: 'hi' })
    expect(res.text).toBe('расчёт готов')
  })
})
