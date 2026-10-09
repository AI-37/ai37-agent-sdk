import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import { taskStateToJSON, type Task } from '@a2a-js/sdk'
import { RequestMalformedError } from '@a2a-js/sdk/errors'
import { InMemoryTaskStore, resolveUserScope, type ServerCallContext, type TaskStore } from '@a2a-js/sdk/server'
import { DatabaseTaskStore, type DatabaseTaskStoreOptions } from '@a2a-js/sdk/server/database'
import { TERMINAL_TASK_STATES } from '../terminal-states'
import { MAX_ID_LENGTH, TASK_TABLE_NAME, checkTaskStoreSchema } from './schema'

export { TERMINAL_TASK_STATES }

const TERMINAL_STATE_NAMES = [...TERMINAL_TASK_STATES].map((s) => taskStateToJSON(s))

/**
 * Ключи `metadata`, которые на сохранённой задаче не нужны. Сервер 1.x сливает `metadata` событий
 * прогресса в задачу, и в строке оседала бы последняя веха/дельта рассуждения (прогресс живёт
 * только в стриме).
 */
const PROGRESS_METADATA_KEYS = ['ai37/node', 'ai37/reasoning', 'ai37/tool']

export interface Ai37TaskStoreOptions {
  /** Таблица задач. По умолчанию `a2a_tasks` (схема — текущая, обычно `public`). */
  tableName?: string
  /** Владелец задачи из контекста вызова. По умолчанию — upstream: `user.userName` или `'unknown'`. */
  ownerResolver?: DatabaseTaskStoreOptions['ownerResolver']
  /**
   * Сколько последних сообщений `history` хранить. Сервер 1.x дописывает в `history` каждое входящее
   * сообщение и каждый `status.message`, и у долгой паузы HITL строка росла бы без предела. Хосту
   * история не нужна (состояние хода — в `metadata.state`). По умолчанию 20; `Infinity` — не резать.
   */
  historyLimit?: number
  /** Куда писать предупреждения (пропуск записи в завершённую задачу). По умолчанию `console.warn`. */
  warn?: (message: string) => void
  /**
   * Схему таблицы ведёт сам сервис (Prisma-миграция и т.п.), а не `a2a-db`: `assertReady` не требует
   * журнала миграций, проверяет таблицу, колонки и ширину id. CLI `migrate` в этом режиме
   * отказывается. Из окружения — `TASK_STORE_EXTERNAL_SCHEMA=true` (`createTaskStoreFromEnv`, CLI).
   */
  externalSchema?: boolean
}

export interface CleanupOptions {
  /** Завершённые задачи (completed/failed/canceled/rejected) старше N дней. */
  terminalDays: number
  /**
   * Незавершённые (паузы HITL, снимки AG-UI, задачи без статуса) старше M дней; M ≥ N.
   * Не задано — незавершённые не трогаются.
   */
  staleDays?: number
  /** Строк за один DELETE. По умолчанию 1000. */
  batchSize?: number
}

export interface CleanupResult {
  terminalDeleted: number
  staleDeleted: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Kysely на Postgres по строке подключения (`postgres://…`).
 *
 * У пула есть обработчик `error`: когда сервер рвёт простаивающее соединение (рестарт или failover
 * Postgres, `pg_terminate_backend`), `pg.Pool` эмитит `error`, и без слушателя процесс падает
 * необработанным событием. Пул сам выбрасывает такое соединение, следующий запрос откроет новое.
 */
export function createPostgresKysely(databaseUrl: string, poolSize = 5): Kysely<unknown> {
  return new Kysely<unknown>({ dialect: new PostgresDialect({ pool: createPostgresPool(databaseUrl, poolSize) }) })
}

/** `pg.Pool` со слушателем `error` (см. `createPostgresKysely`). */
export function createPostgresPool(databaseUrl: string, poolSize = 5): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: poolSize })
  pool.on('error', (e) => {
    console.warn(`[ai37-agent-host] task store: idle Postgres connection dropped: ${e.message}`)
  })
  return pool
}

/**
 * Durable A2A TaskStore на Postgres: upstream `DatabaseTaskStore` (`@a2a-js/sdk/server/database`) и
 * то, чего в нём нет. Паритет с python-host `PostgresTaskStore`. SQL сохранения, чтения и листинга
 * — upstream.
 *
 * - **Владелец** — upstream: ключ строки `(tenant, owner, id)`, `owner` = `user.userName` из
 *   контекста вызова; хост кладёт туда `<org_id>:<sub>` из JWT (`hostUserBuilder`,
 *   `currentCallContext`). Чужую задачу не прочитать и не перезаписать: та же `id` другого
 *   владельца — отдельная строка.
 * - **Завершённая задача неизменяема.** `save` поверх completed/failed/canceled/rejected
 *   пропускается (при смене состояния — предупреждение). Обработчик SDK 1.2+ и так отклоняет
 *   сообщения в такую задачу, но REST-ручки агентов пишут в стор напрямую, а реплики могут прийти с
 *   опозданием. Снимок AG-UI идёт со статусом `TASK_STATE_UNSPECIFIED`, он не завершённый и
 *   перезаписывается каждым ходом треда. Проверка и запись не атомарны: две реплики, пишущие одну
 *   задачу в одну миллисекунду, проверку обойдут — так же, как у python-host.
 * - **id до 255 символов** (`migrate` расширяет колонки); длиннее — `RequestMalformedError`, а не
 *   500 от базы.
 * - **Гигиена строки**: `history` обрезается до `historyLimit`, ключи прогресса из `metadata`
 *   (`ai37/node`, `ai37/reasoning`, `ai37/tool`) не сохраняются.
 * - **Проверка схемы** `assertReady()` и **ретенция** `cleanup()` — для старта пода и CronJob.
 */
export class Ai37TaskStore extends DatabaseTaskStore {
  readonly table: string
  private readonly kysely: Kysely<unknown>
  private readonly resolveOwner: NonNullable<DatabaseTaskStoreOptions['ownerResolver']>
  private readonly historyLimit: number
  private readonly warn: (message: string) => void
  private readonly externalSchema: boolean
  private owned = false

  constructor(db: Kysely<unknown>, opts: Ai37TaskStoreOptions = {}) {
    const tableName = opts.tableName ?? TASK_TABLE_NAME
    const ownerResolver = opts.ownerResolver ?? resolveUserScope
    super(db, { tableName, ownerResolver })
    this.kysely = db
    this.table = tableName
    this.resolveOwner = ownerResolver
    this.historyLimit = opts.historyLimit ?? 20
    this.warn = opts.warn ?? ((m) => console.warn(m))
    this.externalSchema = opts.externalSchema ?? false
  }

  /** Стор со своим пулом соединений; `close()` его закрывает. */
  static fromDatabaseUrl(
    databaseUrl: string,
    opts: Ai37TaskStoreOptions & { poolSize?: number } = {},
  ): Ai37TaskStore {
    const store = new Ai37TaskStore(createPostgresKysely(databaseUrl, opts.poolSize), opts)
    store.owned = true
    return store
  }

  override async save(task: Task, context: ServerCallContext): Promise<void> {
    for (const [name, value] of [['id', task.id], ['contextId', task.contextId]] as const) {
      if ((value ?? '').length > MAX_ID_LENGTH) {
        throw new RequestMalformedError(`task ${name} is longer than ${MAX_ID_LENGTH} characters`)
      }
    }
    const storedState = await this.storedState(task.id, context)
    if (storedState !== undefined && TERMINAL_STATE_NAMES.includes(storedState)) {
      const incoming = task.status ? taskStateToJSON(task.status.state) : 'none'
      if (incoming !== storedState) {
        this.warn(
          `[ai37-agent-host] task store: task ${task.id} is already ${storedState}; ignored update to ${incoming}`,
        )
      }
      return
    }
    await super.save(this.trim(task), context)
  }

  /** Падает (`TaskStoreSchemaError`), если схема не готова: под не должен стартовать без `migrate`. */
  async assertReady(): Promise<void> {
    await checkTaskStoreSchema(this.kysely, this.table, { externalSchema: this.externalSchema })
  }

  /**
   * Ретенция пачками. Возраст — по `status_last_updated` (миллисекунды из `status.timestamp`).
   * Строки без таймстемпа (`status_last_updated = 0`) не удаляются никогда: upstream сортирует их
   * как самые старые, и без этой оговорки они уходили бы первыми.
   */
  async cleanup(opts: CleanupOptions): Promise<CleanupResult> {
    const { terminalDays, staleDays, batchSize = 1000 } = opts
    if (!(terminalDays > 0)) throw new RangeError('terminalDays must be > 0')
    if (staleDays !== undefined && !(staleDays >= terminalDays)) {
      throw new RangeError('staleDays must be >= terminalDays')
    }
    const terminalDeleted = await this.deleteInBatches(true, terminalDays, batchSize)
    const staleDeleted =
      staleDays === undefined ? 0 : await this.deleteInBatches(false, staleDays, batchSize)
    return { terminalDeleted, staleDeleted }
  }

  /** Закрывает пул, если стор создан `fromDatabaseUrl`. */
  async close(): Promise<void> {
    if (this.owned) await this.kysely.destroy()
  }

  private async storedState(taskId: string, context: ServerCallContext): Promise<string | undefined> {
    const { rows } = await sql<{ status_state: string | null }>`
      select status_state from ${sql.table(this.table)}
      where tenant = ${context.tenant ?? ''} and owner = ${this.resolveOwner(context)} and id = ${taskId}
    `.execute(this.kysely)
    if (rows.length === 0) return undefined
    return rows[0].status_state ?? 'none'
  }

  private trim(task: Task): Task {
    const history =
      task.history && task.history.length > this.historyLimit
        ? task.history.slice(task.history.length - this.historyLimit)
        : task.history
    let metadata = task.metadata
    if (metadata && PROGRESS_METADATA_KEYS.some((k) => k in metadata!)) {
      metadata = { ...metadata }
      for (const key of PROGRESS_METADATA_KEYS) delete metadata[key]
    }
    return history === task.history && metadata === task.metadata ? task : { ...task, history, metadata }
  }

  private async deleteInBatches(terminal: boolean, days: number, batchSize: number): Promise<number> {
    const cutoff = Date.now() - days * DAY_MS
    const table = sql.table(this.table)
    const states = sql.join(TERMINAL_STATE_NAMES)
    const stateFilter = terminal
      ? sql`status_state in (${states})`
      : sql`(status_state is null or status_state not in (${states}))`
    let total = 0
    for (;;) {
      const result = await sql`
        delete from ${table} where (tenant, owner, id) in (
          select tenant, owner, id from ${table}
          where ${stateFilter} and status_last_updated > 0 and status_last_updated < ${cutoff}
          limit ${batchSize}
        )
      `.execute(this.kysely)
      const deleted = Number(result.numAffectedRows ?? 0)
      total += deleted
      if (deleted < batchSize) return total
    }
  }
}

/**
 * Проверка стора на старте (паритет python-host `assert_ready`): для `Ai37TaskStore` — схема
 * (`assertReady`), для прочих сторов — ничего. Вызывать до `listen`.
 */
export async function assertTaskStoreReady(store: TaskStore): Promise<void> {
  if (store instanceof Ai37TaskStore) await store.assertReady()
}

/**
 * Стор задач из окружения. Есть `DATABASE_URL` — `Ai37TaskStore`; нет — `InMemoryTaskStore`, но
 * только если стор не обязателен (по умолчанию обязателен при `NODE_ENV=production`): в проде без
 * базы хост не стартует, тихого отката на память нет. `TASK_STORE_EXTERNAL_SCHEMA=true` — схему
 * ведёт сервис (см. `Ai37TaskStoreOptions.externalSchema`); явная опция важнее переменной.
 */
export function createTaskStoreFromEnv(
  opts: Ai37TaskStoreOptions & { env?: NodeJS.ProcessEnv; required?: boolean; poolSize?: number } = {},
): TaskStore {
  const env = opts.env ?? process.env
  const url = env.DATABASE_URL
  if (url) {
    const externalSchema = opts.externalSchema ?? externalSchemaFromEnv(env)
    return Ai37TaskStore.fromDatabaseUrl(url, { ...opts, externalSchema })
  }
  const required = opts.required ?? env.NODE_ENV === 'production'
  if (required) {
    throw new Error('[ai37-agent-host] task store: DATABASE_URL is not set (required in production)')
  }
  return new InMemoryTaskStore()
}

/** `TASK_STORE_EXTERNAL_SCHEMA`: схему таблицы задач ведёт сам сервис, а не `a2a-db`. */
export function externalSchemaFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env.TASK_STORE_EXTERNAL_SCHEMA === 'true'
}
