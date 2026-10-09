import { describe, expect, it } from 'vitest'
import { TaskState } from '@a2a-js/sdk'
import { finalTaskEvents, formArtifactId, toAguiSnapshot, toTask } from '../src/build-task'
import { artifact, data, task } from './fixtures/a2a-v1'

const NEG = { text: 'text/plain', catalogIds: ['cat'], catalogId: 'cat' }
const form = { component: 'FormCard', props: {}, catalogId: 'cat' }

describe('finalTaskEvents: сервер 1.x сливает задачу, хост чистит хвосты прошлого хода', () => {
  it('без прогресса — один task; форма прошлого шага очищается, state прошлого хода → null', () => {
    const prior = task('t', TaskState.TASK_STATE_INPUT_REQUIRED, {
      artifacts: [artifact(formArtifactId('t'), [data({ a2ui: [{ component: form }] })])],
      metadata: { state: { step: 1 } },
    })
    const final = toTask({ status: 'completed', message: 'ok' }, 't', 'c', NEG)
    const events = finalTaskEvents(final, prior, false)
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('task')
    const sent = events[0].data as typeof final
    expect(sent.metadata).toEqual({ state: null })
    expect(sent.artifacts.find((a) => a.artifactId === formArtifactId('t'))?.parts).toEqual([])
    expect(sent.artifacts.some((a) => a.name === 'result')).toBe(true)
  })

  it('новая форма заменяет старую тем же id, лишнего пустого артефакта нет', () => {
    const prior = task('t', TaskState.TASK_STATE_INPUT_REQUIRED, {
      artifacts: [artifact(formArtifactId('t'), [data({ a2ui: [] })])],
      metadata: { state: { step: 1 } },
    })
    const final = toTask({ status: 'input-required', followup: form, state: { step: 2 } }, 't', 'c', NEG)
    const [event] = finalTaskEvents(final, prior, false)
    const sent = event.data as typeof final
    expect(sent.artifacts.map((a) => a.artifactId)).toEqual([formArtifactId('t')])
    expect(sent.metadata).toEqual({ state: { step: 2 } })
  })

  it('после прогресса — artifact-update по каждому артефакту и status-update с метаданными', () => {
    const final = toTask({ status: 'input-required', followup: form, state: { step: 1 } }, 't', 'c', NEG)
    const events = finalTaskEvents(final, undefined, true)
    expect(events.map((e) => e.kind)).toEqual(['artifactUpdate', 'statusUpdate'])
    expect(events[1].data).toMatchObject({
      taskId: 't',
      status: { state: TaskState.TASK_STATE_INPUT_REQUIRED },
      metadata: { state: { step: 1 } },
    })
  })

  it('первый ход без прошлой задачи — ничего не чистит', () => {
    const final = toTask({ status: 'completed' }, 't', 'c', NEG)
    const [event] = finalTaskEvents(final, undefined, false)
    expect((event.data as typeof final).metadata).toBeUndefined()
    expect((event.data as typeof final).artifacts.map((a) => a.name)).toEqual(['result'])
  })
})

describe('toTask: форма input-required', () => {
  it('канонично — data-частью в status.message рядом с текстом, копия в артефакте при compat', () => {
    const t = toTask({ status: 'input-required', message: 'нужны данные', followup: form }, 't', 'c', NEG)
    const parts = t.status?.message?.parts.map((p) => p.content)
    expect(parts?.[0]).toEqual({ $case: 'text', value: 'нужны данные' })
    expect(parts?.[1]).toMatchObject({ $case: 'data', value: { a2ui: [{ component: form, surfaceId: 'surf-t' }] } })
    expect(t.artifacts.map((a) => a.artifactId)).toEqual([formArtifactId('t')])
    expect(t.artifacts[0].parts[0].content).toEqual(parts?.[1])
  })

  it('legacyFormArtifact: false — копии в артефакте нет, форма только в status.message', () => {
    const t = toTask({ status: 'input-required', followup: form }, 't', 'c', NEG, { legacyFormArtifact: false })
    expect(t.artifacts).toEqual([])
    expect(t.status?.message?.parts.some((p) => p.content?.$case === 'data')).toBe(true)
  })

  it('completed и failed — без data-части в status.message', () => {
    for (const status of ['completed', 'failed'] as const) {
      const t = toTask({ status, message: 'x', a2ui: [form] }, 't', 'c', NEG)
      expect(t.status?.message?.parts.map((p) => p.content?.$case)).toEqual(['text'])
    }
  })
})

describe('toAguiSnapshot', () => {
  it('completed и failed → UNSPECIFIED, input-required остаётся', () => {
    expect(toAguiSnapshot({ status: 'completed', state: { a: 1 } }, 'th').status?.state).toBe(
      TaskState.TASK_STATE_UNSPECIFIED,
    )
    expect(toAguiSnapshot({ status: 'failed' }, 'th').status?.state).toBe(TaskState.TASK_STATE_UNSPECIFIED)
    expect(toAguiSnapshot({ status: 'input-required' }, 'th').status?.state).toBe(
      TaskState.TASK_STATE_INPUT_REQUIRED,
    )
    expect(toAguiSnapshot({ status: 'completed', state: { a: 1 } }, 'th').metadata).toEqual({ state: { a: 1 } })
  })
})
