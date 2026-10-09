/**
 * Postgres-стор задач против настоящего Postgres (17 в CI). Нужен `TEST_DATABASE_URL` с правом
 * CREATE DATABASE: каждый блок работает в своей временной базе и удаляет её. Без переменной
 * блок пропускается (локально: `docker run postgres:17-alpine`, см. README пакета).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { Kysely, sql } from 'kysely'
import { Role, TaskState, type Task } from '@a2a-js/sdk'
import { RequestMalformedError } from '@a2a-js/sdk/errors'
import { ServerCallContext } from '@a2a-js/sdk/server'
import { createTestKeyset, TEST_AUDIENCE, TEST_ISSUER, type TestKeyset } from '@ai37/agent-sdk/testing'
import { createAgentHost, JwtUser, type AgentHandler, type Ai37AgentCardInput } from '../src/index'
import {
  Ai37TaskStore,
  TaskStoreSchemaError,
  assertTaskStoreReady,
  checkTaskStoreSchema,
  createPostgresKysely,
  createTaskStoreFromEnv,
  migrateTaskStore,
} from '../src/task-store/index'
import { main as cli } from '../src/cli/task-store'
import { toAguiSnapshot, toTask } from '../src/build-task'

vi.mock('../src/observability/langfuse', () => ({
  withTurnObservability: async (_context: unknown, run: () => Promise<unknown>) => run(),
  injectTraceContext: () => ({}),
}))

const BASE_URL = process.env.TEST_DATABASE_URL
if (!BASE_URL && process.env.REQUIRE_TEST_DATABASE) {
  throw new Error('REQUIRE_TEST_DATABASE is set but TEST_DATABASE_URL is empty: Postgres tests would be skipped')
}

/** Временная база на время блока: url, Kysely и уборка. */
async function freshDatabase(): Promise<{ url: string; db: Kysely<unknown>; drop: () => Promise<void> }> {
  const admin = createPostgresKysely(BASE_URL!, 1)
  const name = `ts_task_store_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  await sql`create database ${sql.id(name)}`.execute(admin)
  const url = new URL(BASE_URL!)
  url.pathname = `/${name}`
  const db = createPostgresKysely(url.toString(), 4)
  return {
    url: url.toString(),
    db,
    drop: async () => {
      await db.destroy()
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin)
      await admin.destroy()
    },
  }
}

const ctx = (sub: string, org = 'org-1') => new ServerCallContext({ user: new JwtUser(sub, org) })

const NEG = { text: 'text/plain', catalogIds: [], catalogId: null }

function makeTask(id: string, state: TaskState, opts: { contextId?: string; at?: Date; metadata?: Record<string, unknown> } = {}): Task {
  return {
    id,
    contextId: opts.contextId ?? 'ctx',
    status: { state, message: undefined, timestamp: (opts.at ?? new Date()).toISOString() },
    artifacts: [],
    history: [],
    metadata: opts.metadata,
  }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

async function columns(db: Kysely<unknown>, table: string) {
  const { rows } = await sql<{ column_name: string; width: number | null; collation_name: string | null }>`
    select column_name, character_maximum_length as width, collation_name from information_schema.columns
    where table_schema = current_schema() and table_name = ${table} order by ordinal_position
  `.execute(db)
  return rows
}

describe.skipIf(!BASE_URL)('схема: migrate / check (Postgres)', () => {
  it('migrate идемпотентен: таблица, журнал, id/context_id varchar(255) collate "C"', async () => {
    const { url, db, drop } = await freshDatabase()
    try {
      await migrateTaskStore(db, url)
      await migrateTaskStore(db, url)
      await checkTaskStoreSchema(db)
      const cols = await columns(db, 'a2a_tasks')
      expect(cols.find((c) => c.column_name === 'id')).toMatchObject({ width: 255, collation_name: 'C' })
      expect(cols.find((c) => c.column_name === 'context_id')).toMatchObject({ width: 255, collation_name: 'C' })
      const ledger = await sql<{ name: string }>`select name from a2a_a2a_tasks_migrations`.execute(db)
      expect(ledger.rows.map((r) => r.name)).toEqual(['0001_create_tasks'])
    } finally {
      await drop()
    }
  })

  it('два параллельных migrate (реплики initContainer) — оба успешны', async () => {
    const { url, db, drop } = await freshDatabase()
    const other = createPostgresKysely(url, 1)
    try {
      await Promise.all([migrateTaskStore(db, url), migrateTaskStore(other, url)])
      await checkTaskStoreSchema(db)
    } finally {
      await other.destroy()
      await drop()
    }
  })

  it('чужая таблица a2a_tasks → отказ, база не меняется', async () => {
    const { url, db, drop } = await freshDatabase()
    try {
      // Схема python-host / старой a2a_tasks: другие колонки.
      await sql`create table a2a_tasks (id varchar(36) primary key, kind text, data json)`.execute(db)
      const before = await columns(db, 'a2a_tasks')
      await expect(migrateTaskStore(db, url)).rejects.toThrow(/not an A2A task table/)
      await expect(migrateTaskStore(db, url)).rejects.toBeInstanceOf(TaskStoreSchemaError)
      expect(await columns(db, 'a2a_tasks')).toEqual(before)
      const ledger = await sql`select 1 from information_schema.tables where table_name = 'a2a_a2a_tasks_migrations'`.execute(db)
      expect(ledger.rows).toHaveLength(0)
      await expect(checkTaskStoreSchema(db)).rejects.toThrow(/not an A2A task table/)
    } finally {
      await drop()
    }
  })

  it('check: нет таблицы / узкие колонки / ok', async () => {
    const { url, db, drop } = await freshDatabase()
    try {
      await expect(checkTaskStoreSchema(db)).rejects.toThrow(/not found.*migrate/)
      await migrateTaskStore(db, url)
      await sql`alter table a2a_tasks alter column id type varchar(36) collate "C"`.execute(db)
      await expect(checkTaskStoreSchema(db)).rejects.toThrow(/too narrow \(id=36\)/)
      // migrate чинит ширину повторно.
      await migrateTaskStore(db, url)
      await checkTaskStoreSchema(db)
      await expect(new Ai37TaskStore(db).assertReady()).resolves.toBeUndefined()
      await expect(assertTaskStoreReady(new Ai37TaskStore(db))).resolves.toBeUndefined()
    } finally {
      await drop()
    }
  })

  it('CLI: migrate/check/cleanup с кодами выхода; без DATABASE_URL — 1, без команды — 2', async () => {
    const { url, drop } = await freshDatabase()
    try {
      const lines: string[] = []
      const io = (env: NodeJS.ProcessEnv) => ({ env, out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`) })
      expect(await cli(['check'], io({ DATABASE_URL: url }))).toBe(1)
      expect(lines.at(-1)).toMatch(/^ERR ai37 task store: table a2a_tasks not found/)
      expect(await cli(['migrate'], io({ DATABASE_URL: url }))).toBe(0)
      expect(await cli(['check'], io({ DATABASE_URL: url }))).toBe(0)
      expect(lines.at(-1)).toBe('ai37 task store: ok (a2a_tasks)')
      expect(await cli(['cleanup'], io({ DATABASE_URL: url }))).toBe(0)
      expect(lines.at(-1)).toBe('ai37 task store: deleted 0 terminal (>7d), 0 stale (>14d)')
      expect(await cli(['cleanup', '--terminal-days', '14', '--stale-days', '7'], io({ DATABASE_URL: url }))).toBe(1)
      expect(await cli(['cleanup', '--keep-stale'], io({ DATABASE_URL: url }))).toBe(0)
      expect(lines.at(-1)).toMatch(/0 stale \(kept\)$/)
      expect(await cli(['check'], io({}))).toBe(1)
      expect(lines.at(-1)).toBe('ERR ai37 task store: DATABASE_URL is not set')
      expect(await cli([], io({ DATABASE_URL: url }))).toBe(2)
      expect(await cli(['drop'], io({ DATABASE_URL: url }))).toBe(2)
    } finally {
      await drop()
    }
  })
})

/**
 * Таблица, которую создаёт сам сервис, а не a2a-db: тот же SQL, что Prisma-миграция chat-backend
 * (`prisma/migrations/*_a2a_tasks`). Журнала `a2a_a2a_tasks_migrations` у неё нет.
 */
async function createServiceManagedTable(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table "a2a_tasks" (
      "tenant" varchar(255) collate "C" not null,
      "owner" varchar(255) collate "C" not null,
      "id" varchar(255) collate "C" not null,
      "context_id" varchar(255) collate "C" not null,
      "status_last_updated" bigint not null,
      "status_state" varchar(255) collate "C",
      "status" text,
      "artifacts" text,
      "history" text,
      "metadata" text,
      "protocol_version" varchar(255),
      constraint "a2a_tasks_pkey" primary key ("tenant", "owner", "id")
    )
  `.execute(db)
  await sql`create index "a2a_tasks_scope_context_updated_idx" on "a2a_tasks" ("tenant", "owner", "context_id", "status_last_updated", "id")`.execute(db)
  await sql`create index "a2a_tasks_scope_updated_idx" on "a2a_tasks" ("tenant", "owner", "status_last_updated", "id")`.execute(db)
}

describe.skipIf(!BASE_URL)('схема ведёт сервис: externalSchema / TASK_STORE_EXTERNAL_SCHEMA (Postgres)', () => {
  it('без режима нужен журнал a2a-db; с режимом — таблица, колонки и ширина', async () => {
    const { db, drop } = await freshDatabase()
    try {
      await expect(checkTaskStoreSchema(db, 'a2a_tasks', { externalSchema: true })).rejects.toThrow(
        /not found.*managed by the service/,
      )
      await createServiceManagedTable(db)
      await expect(checkTaskStoreSchema(db)).rejects.toThrow(/no migration ledger/)
      await expect(new Ai37TaskStore(db).assertReady()).rejects.toThrow(/no migration ledger/)
      await checkTaskStoreSchema(db, 'a2a_tasks', { externalSchema: true })
      await expect(new Ai37TaskStore(db, { externalSchema: true }).assertReady()).resolves.toBeUndefined()
      // Ширину и колонки режим не прощает.
      await sql`alter table a2a_tasks alter column context_id type varchar(36) collate "C"`.execute(db)
      await expect(new Ai37TaskStore(db, { externalSchema: true }).assertReady()).rejects.toThrow(
        /too narrow \(context_id=36\)/,
      )
    } finally {
      await drop()
    }
  })

  it('createTaskStoreFromEnv берёт режим из TASK_STORE_EXTERNAL_SCHEMA; save/load работают', async () => {
    const { url, db, drop } = await freshDatabase()
    try {
      await createServiceManagedTable(db)
      const strict = createTaskStoreFromEnv({ env: { DATABASE_URL: url } }) as Ai37TaskStore
      const managed = createTaskStoreFromEnv({
        env: { DATABASE_URL: url, TASK_STORE_EXTERNAL_SCHEMA: 'true' },
      }) as Ai37TaskStore
      try {
        await expect(assertTaskStoreReady(strict)).rejects.toThrow(/no migration ledger/)
        await expect(assertTaskStoreReady(managed)).resolves.toBeUndefined()
        const task = makeTask('t-ext', TaskState.TASK_STATE_INPUT_REQUIRED, { contextId: 'th_' + randomUUID() })
        await managed.save(task, ctx('alice'))
        expect((await managed.load('t-ext', ctx('alice')))?.contextId).toBe(task.contextId)
        expect(await managed.load('t-ext', ctx('bob'))).toBeUndefined()
      } finally {
        await strict.close()
        await managed.close()
      }
    } finally {
      await drop()
    }
  })

  it('CLI с TASK_STORE_EXTERNAL_SCHEMA: check и cleanup работают, migrate отказывается и журнал не заводит', async () => {
    const { url, db, drop } = await freshDatabase()
    try {
      await createServiceManagedTable(db)
      const lines: string[] = []
      const io = (env: NodeJS.ProcessEnv) => ({ env, out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`) })
      const managed = { DATABASE_URL: url, TASK_STORE_EXTERNAL_SCHEMA: 'true' }
      expect(await cli(['check'], io({ DATABASE_URL: url }))).toBe(1)
      expect(await cli(['check'], io(managed))).toBe(0)
      expect(lines.at(-1)).toBe('ai37 task store: ok (a2a_tasks)')
      expect(await cli(['cleanup'], io(managed))).toBe(0)
      expect(lines.at(-1)).toBe('ai37 task store: deleted 0 terminal (>7d), 0 stale (>14d)')
      expect(await cli(['migrate'], io(managed))).toBe(1)
      expect(lines.at(-1)).toMatch(/^ERR ai37 task store: migrate is disabled: TASK_STORE_EXTERNAL_SCHEMA=true/)
      const ledger = await sql`select 1 from information_schema.tables where table_name = 'a2a_a2a_tasks_migrations'`.execute(db)
      expect(ledger.rows).toHaveLength(0)
    } finally {
      await drop()
    }
  })
})

describe.skipIf(!BASE_URL)('Ai37TaskStore (Postgres)', () => {
  let env: Awaited<ReturnType<typeof freshDatabase>>
  let store: Ai37TaskStore
  const warnings: string[] = []

  beforeAll(async () => {
    env = await freshDatabase()
    await migrateTaskStore(env.db, env.url)
    store = new Ai37TaskStore(env.db, { warn: (m) => warnings.push(m), historyLimit: 3 })
  })
  afterAll(() => env?.drop())

  it('владелец: чужой не видит и не перезаписывает, та же id — отдельная строка', async () => {
    const id = randomUUID()
    await store.save(makeTask(id, TaskState.TASK_STATE_INPUT_REQUIRED, { metadata: { state: { who: 'alice' } } }), ctx('alice'))
    expect(await store.load(id, ctx('bob'))).toBeUndefined()
    expect(await store.load(id, ctx('alice', 'org-2'))).toBeUndefined()
    await store.save(makeTask(id, TaskState.TASK_STATE_INPUT_REQUIRED, { metadata: { state: { who: 'bob' } } }), ctx('bob'))
    expect((await store.load(id, ctx('alice')))?.metadata?.state).toEqual({ who: 'alice' })
    expect((await store.load(id, ctx('bob')))?.metadata?.state).toEqual({ who: 'bob' })
    const { rows } = await sql<{ owner: string }>`select owner from a2a_tasks where id = ${id} order by owner`.execute(env.db)
    expect(rows.map((r) => r.owner)).toEqual(['org-1:alice', 'org-1:bob'])
  })

  it('id и contextId: th_<uuid> (39) и 255 символов проходят, 256 — RequestMalformedError', async () => {
    const th = `th_${randomUUID()}`
    expect(th).toHaveLength(39)
    await store.save(makeTask(th, TaskState.TASK_STATE_INPUT_REQUIRED, { contextId: th }), ctx('alice'))
    expect((await store.load(th, ctx('alice')))?.contextId).toBe(th)
    const long = 'x'.repeat(255)
    await store.save(makeTask(long, TaskState.TASK_STATE_WORKING, { contextId: long }), ctx('alice'))
    expect((await store.load(long, ctx('alice')))?.id).toBe(long)
    await expect(store.save(makeTask('y'.repeat(256), TaskState.TASK_STATE_WORKING), ctx('alice'))).rejects.toBeInstanceOf(
      RequestMalformedError,
    )
    await expect(
      store.save(makeTask(randomUUID(), TaskState.TASK_STATE_WORKING, { contextId: 'z'.repeat(256) }), ctx('alice')),
    ).rejects.toBeInstanceOf(RequestMalformedError)
  })

  it('завершённая задача неизменяема: поздняя запись пропускается с предупреждением', async () => {
    const id = randomUUID()
    await store.save(makeTask(id, TaskState.TASK_STATE_COMPLETED, { metadata: { state: { done: true } } }), ctx('alice'))
    warnings.length = 0
    await store.save(makeTask(id, TaskState.TASK_STATE_INPUT_REQUIRED, { metadata: { state: { late: true } } }), ctx('alice'))
    const stored = await store.load(id, ctx('alice'))
    expect(stored?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(stored?.metadata?.state).toEqual({ done: true })
    expect(warnings).toEqual([
      `[ai37-agent-host] task store: task ${id} is already TASK_STATE_COMPLETED; ignored update to TASK_STATE_INPUT_REQUIRED`,
    ])
    // Повтор того же состояния — молча.
    await store.save(makeTask(id, TaskState.TASK_STATE_COMPLETED), ctx('alice'))
    expect(warnings).toHaveLength(1)
    // Другой владелец с той же id не задет терминальностью чужой строки.
    await store.save(makeTask(id, TaskState.TASK_STATE_INPUT_REQUIRED), ctx('bob'))
    expect((await store.load(id, ctx('bob')))?.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
  })

  it('снимок AG-UI (UNSPECIFIED) переписывается каждым ходом, в т.ч. после completed хода', async () => {
    const thread = `th_${randomUUID()}`
    for (let step = 1; step <= 3; step += 1) {
      await store.save(toAguiSnapshot({ status: 'completed', state: { step } }, thread, NEG), ctx('alice'))
      const stored = await store.load(thread, ctx('alice'))
      expect(stored?.status?.state).toBe(TaskState.TASK_STATE_UNSPECIFIED)
      expect(stored?.metadata?.state).toEqual({ step })
    }
  })

  it('гигиена строки: history обрезается, ключи прогресса из metadata не сохраняются', async () => {
    const id = randomUUID()
    const msg = (n: number) => ({
      messageId: `m${n}`, contextId: 'ctx', taskId: id, role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text' as const, value: `msg ${n}` }, metadata: undefined, filename: '', mediaType: '' }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    })
    const task = {
      ...makeTask(id, TaskState.TASK_STATE_INPUT_REQUIRED, {
        metadata: { state: { s: 1 }, 'ai37/node': 'work', 'ai37/reasoning': 'думаю', 'ai37/tool': { id: 't' } },
      }),
      history: [1, 2, 3, 4, 5].map(msg),
    }
    await store.save(task, ctx('alice'))
    const stored = await store.load(id, ctx('alice'))
    expect(stored?.history.map((m) => m.messageId)).toEqual(['m3', 'm4', 'm5'])
    expect(stored?.metadata).toEqual({ state: { s: 1 } })
    // Исходная задача не мутирована.
    expect(task.history).toHaveLength(5)
    expect(task.metadata?.['ai37/node']).toBe('work')
  })

  it('metadata.state: null (очистка из finalTaskEvents) переживает protobuf-JSON', async () => {
    const id = randomUUID()
    await store.save(makeTask(id, TaskState.TASK_STATE_INPUT_REQUIRED, { metadata: { state: null } }), ctx('alice'))
    expect((await store.load(id, ctx('alice')))?.metadata).toEqual({ state: null })
  })
})

describe.skipIf(!BASE_URL)('cleanup: ретенция 7/14 пачками (Postgres)', () => {
  it('завершённые > N дней, незавершённые > M дней, без таймстемпа — никогда; пачки', async () => {
    const env = await freshDatabase()
    try {
      await migrateTaskStore(env.db, env.url)
      const store = new Ai37TaskStore(env.db)
      const put = (id: string, state: TaskState, at?: Date) => store.save(makeTask(id, state, { at }), ctx('alice'))
      await put('done-old', TaskState.TASK_STATE_COMPLETED, daysAgo(8))
      await put('failed-old', TaskState.TASK_STATE_FAILED, daysAgo(30))
      await put('done-fresh', TaskState.TASK_STATE_COMPLETED, daysAgo(6))
      await put('pause-old', TaskState.TASK_STATE_INPUT_REQUIRED, daysAgo(15))
      await put('pause-fresh', TaskState.TASK_STATE_INPUT_REQUIRED, daysAgo(13))
      await put('agui-old', TaskState.TASK_STATE_UNSPECIFIED, daysAgo(20))
      // Без таймстемпа: status_last_updated = 0 — upstream считает её «самой старой».
      await store.save({ ...makeTask('no-ts', TaskState.TASK_STATE_COMPLETED), status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined } }, ctx('alice'))
      await store.save({ ...makeTask('no-ts-pause', TaskState.TASK_STATE_INPUT_REQUIRED), status: { state: TaskState.TASK_STATE_INPUT_REQUIRED, message: undefined, timestamp: undefined } }, ctx('alice'))
      for (let i = 0; i < 25; i += 1) await put(`bulk-${i}`, TaskState.TASK_STATE_CANCELED, daysAgo(9))

      const ids = async () =>
        (await sql<{ id: string }>`select id from a2a_tasks order by id`.execute(env.db)).rows.map((r) => r.id)

      // Без staleDays незавершённые не трогаются.
      const first = await store.cleanup({ terminalDays: 7, batchSize: 10 })
      expect(first).toEqual({ terminalDeleted: 27, staleDeleted: 0 })
      expect(await ids()).toEqual(['agui-old', 'done-fresh', 'no-ts', 'no-ts-pause', 'pause-fresh', 'pause-old'])

      const second = await store.cleanup({ terminalDays: 7, staleDays: 14, batchSize: 1 })
      expect(second).toEqual({ terminalDeleted: 0, staleDeleted: 2 })
      expect(await ids()).toEqual(['done-fresh', 'no-ts', 'no-ts-pause', 'pause-fresh'])

      await expect(store.cleanup({ terminalDays: 14, staleDays: 7 })).rejects.toBeInstanceOf(RangeError)
      await expect(store.cleanup({ terminalDays: 0 })).rejects.toBeInstanceOf(RangeError)
    } finally {
      await env.drop()
    }
  })
})

describe.skipIf(!BASE_URL)('createAgentHost + Ai37TaskStore: HITL переживает рестарт', () => {
  let keys: TestKeyset
  beforeAll(async () => {
    keys = await createTestKeyset()
  })

  const card: Ai37AgentCardInput = {
    name: 'pg wizard', description: 'd', version: '1', url: 'http://localhost/a2a/v1',
    capabilities: { streaming: true }, defaultInputModes: ['application/json'], defaultOutputModes: ['text/plain'],
    skills: [{ id: 's', name: 's', description: 'd', tags: [] }],
  }
  const wizard: AgentHandler = {
    async run({ input }) {
      const step = (input.taskState?.step as number | undefined) ?? 0
      if (step === 0) return { status: 'input-required', message: 'уточните', state: { step: 1 } }
      return { status: 'completed', message: `готово после шага ${step}` }
    },
  }
  const host = (store: Ai37TaskStore) =>
    createAgentHost({
      card,
      handler: wizard,
      taskStore: store,
      agentContext: {
        auth: { issuers: [{ issuer: TEST_ISSUER, audience: TEST_AUDIENCE, jwks: keys.jwks }], required: true },
        billing: { baseUrl: 'http://localhost:9999', appsAuthToken: 'apps-test' },
      },
    })
  const send = (app: ReturnType<typeof createAgentHost>, bearer: string, taskId?: string) =>
    request(app)
      .post('/a2a/v1')
      .set('Authorization', `Bearer ${bearer}`)
      .send({
        jsonrpc: '2.0', id: '1', method: 'message/send',
        params: { message: { kind: 'message', messageId: randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'go' }], ...(taskId ? { taskId } : {}) } },
      })

  it('A2A: пауза → новый экземпляр хоста и стора на той же базе → продолжение тем же taskId; чужой — not found', async () => {
    const env = await freshDatabase()
    try {
      await migrateTaskStore(env.db, env.url)
      const alice = await keys.sign({ sub: 'alice', org_id: 'org-1', billing_org_id: 'b' })
      const bob = await keys.sign({ sub: 'bob', org_id: 'org-1', billing_org_id: 'b' })

      const store1 = Ai37TaskStore.fromDatabaseUrl(env.url)
      await assertTaskStoreReady(store1)
      const r1 = await send(host(store1), alice)
      expect(r1.body.result.status.state).toBe('input-required')
      const taskId: string = r1.body.result.id
      await store1.close()

      // «Рестарт»: новый пул, новый стор, новый хост.
      const store2 = Ai37TaskStore.fromDatabaseUrl(env.url)
      await assertTaskStoreReady(store2)
      const app2 = host(store2)
      const stolen = await send(app2, bob, taskId)
      expect(stolen.body.error?.code).toBe(-32001)
      const r2 = await send(app2, alice, taskId)
      expect(r2.body.result.status.state).toBe('completed')
      expect(r2.body.result.status.message.parts[0].text).toBe('готово после шага 1')
      // Завершённую задачу не продолжить: клиенту 0.3 — not found, relay повторит новым диалогом.
      const again = await send(app2, alice, taskId)
      expect(again.body.error?.code).toBe(-32001)

      const { rows } = await sql<{ owner: string; status_state: string; history: string | null; metadata: string | null }>`
        select owner, status_state, history, metadata from a2a_tasks where id = ${taskId}
      `.execute(env.db)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ owner: 'org-1:alice', status_state: 'TASK_STATE_COMPLETED' })
      await store2.close()
    } finally {
      await env.drop()
    }
  })

  it('AG-UI: состояние треда переживает рестарт, тред не замерзает после completed', async () => {
    const env = await freshDatabase()
    try {
      await migrateTaskStore(env.db, env.url)
      const alice = await keys.sign({ sub: 'alice', org_id: 'org-1', billing_org_id: 'b' })
      const thread = `th_${randomUUID()}`
      const agui = (app: ReturnType<typeof createAgentHost>) =>
        request(app).post('/agui').set('Authorization', `Bearer ${alice}`).send({ threadId: thread, runId: 'r', messages: [{ role: 'user', content: 'go' }] })

      const s1 = Ai37TaskStore.fromDatabaseUrl(env.url)
      await agui(host(s1))
      await s1.close()
      const s2 = Ai37TaskStore.fromDatabaseUrl(env.url)
      const second = await agui(host(s2))
      expect(second.text).toContain('готово после шага 1')
      // completed хода записан снимком UNSPECIFIED — следующий ход того же треда не отклонён.
      const third = await agui(host(s2))
      expect(third.text).toContain('уточните')
      await s2.close()
    } finally {
      await env.drop()
    }
  })
})

describe('без базы', () => {
  it('toTask и снимок AG-UI — разные состояния (sanity для неизменяемости)', () => {
    expect(toTask({ status: 'completed' }, 't', 'c').status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(toAguiSnapshot({ status: 'completed' }, 't').status?.state).toBe(TaskState.TASK_STATE_UNSPECIFIED)
  })
})
