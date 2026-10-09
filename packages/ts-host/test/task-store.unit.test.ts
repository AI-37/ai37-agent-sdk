import { describe, expect, it, vi } from 'vitest'
import { TaskState, type Task } from '@a2a-js/sdk'
import { InMemoryTaskStore, ServerCallContext } from '@a2a-js/sdk/server'
import type { AgentContext } from '@ai37/agent-sdk'
import { JwtUser, requestScope, saveTaskState } from '../src/index'
import { Ai37TaskStore, assertTaskStoreReady, createTaskStoreFromEnv } from '../src/task-store/index'

const alice = () => new ServerCallContext({ user: new JwtUser('alice', 'org-1') })
const asAlice = <T>(fn: () => Promise<T>) =>
  requestScope.run({ ctx: { claims: { sub: 'alice', org_id: 'org-1' } } as unknown as AgentContext }, fn)

function task(id: string, state: TaskState): Task {
  return {
    id,
    contextId: 'c',
    status: { state, message: undefined, timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
    metadata: { state: { step: 1 } },
  }
}

describe('saveTaskState и завершённая задача', () => {
  it('в паузу пишет, в completed/failed — нет (false), состояние не меняется', async () => {
    const store = new InMemoryTaskStore()
    await store.save(task('pause', TaskState.TASK_STATE_INPUT_REQUIRED), alice())
    await store.save(task('done', TaskState.TASK_STATE_COMPLETED), alice())
    await store.save(task('failed', TaskState.TASK_STATE_FAILED), alice())
    expect(await asAlice(() => saveTaskState(store, 'pause', { step: 2 }))).toBe(true)
    expect(await asAlice(() => saveTaskState(store, 'done', { step: 2 }))).toBe(false)
    expect(await asAlice(() => saveTaskState(store, 'failed', { step: 2 }))).toBe(false)
    expect((await store.load('pause', alice()))?.metadata?.state).toEqual({ step: 2 })
    expect((await store.load('done', alice()))?.metadata?.state).toEqual({ step: 1 })
  })
})

describe('createTaskStoreFromEnv / assertTaskStoreReady', () => {
  it('без DATABASE_URL: в проде — ошибка, вне прода — InMemoryTaskStore', () => {
    expect(() => createTaskStoreFromEnv({ env: { NODE_ENV: 'production' } })).toThrow(/DATABASE_URL is not set/)
    expect(() => createTaskStoreFromEnv({ env: {}, required: true })).toThrow(/DATABASE_URL/)
    expect(createTaskStoreFromEnv({ env: { NODE_ENV: 'development' } })).toBeInstanceOf(InMemoryTaskStore)
  })

  it('с DATABASE_URL — Ai37TaskStore (подключение ленивое)', async () => {
    const store = createTaskStoreFromEnv({ env: { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' } })
    expect(store).toBeInstanceOf(Ai37TaskStore)
    await (store as Ai37TaskStore).close()
  })

  it('assertTaskStoreReady для InMemoryTaskStore — no-op', async () => {
    await expect(assertTaskStoreReady(new InMemoryTaskStore())).resolves.toBeUndefined()
  })
})

describe('createPostgresPool', () => {
  it('ошибка простаивающего соединения не роняет процесс: у пула есть слушатель error', async () => {
    const { createPostgresPool } = await import('../src/task-store/index')
    const pool = createPostgresPool('postgres://u:p@127.0.0.1:1/x', 1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(pool.listenerCount('error')).toBe(1)
      // Без слушателя emit('error') бросил бы исключение (необработанное событие EventEmitter).
      expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('idle Postgres connection dropped'))
    } finally {
      warn.mockRestore()
      await pool.end()
    }
  })
})
