import { sql, type Kysely } from 'kysely'

/** Таблица задач по умолчанию (решение владельца 08.10, как у python-host): `public.a2a_tasks`. */
export const TASK_TABLE_NAME = 'a2a_tasks'

/**
 * Ширина `id`/`context_id` после `migrate`. Upstream создаёт их `varchar(36)`, а `contextId` старых
 * тредов chat-backend — `th_<uuid>` (39 символов).
 */
export const MAX_ID_LENGTH = 255

/** Колонки таблицы задач `DatabaseTaskStore` (`TaskRow` в `@a2a-js/sdk/server/database`). */
export const TASK_TABLE_COLUMNS = [
  'tenant',
  'owner',
  'id',
  'context_id',
  'status_last_updated',
  'status_state',
  'status',
  'artifacts',
  'history',
  'metadata',
  'protocol_version',
] as const

/** Журнал миграций `a2a-db` для таблицы `tableName` (`a2a_<table>_migrations`). */
export function ledgerTableFor(tableName: string): string {
  return `a2a_${tableName}_migrations`
}

/** Схема стора не готова: таблицы нет, она чужая или колонки узкие. Сообщение — для оператора. */
export class TaskStoreSchemaError extends Error {
  override readonly name = 'TaskStoreSchemaError'
}

type AnyDb = Kysely<any>

/** Таблица есть в текущей схеме (`current_schema()`, обычно `public`)? */
export async function tableExists(db: AnyDb, tableName: string): Promise<boolean> {
  const { rows } = await sql<{ found: number }>`
    select 1 as found from information_schema.tables
    where table_schema = current_schema() and table_name = ${tableName}
  `.execute(db)
  return rows.length > 0
}

/** Колонки задачи, которых нет в существующей таблице `tableName`. */
export async function missingTaskColumns(db: AnyDb, tableName: string): Promise<string[]> {
  const { rows } = await sql<{ column_name: string }>`
    select column_name from information_schema.columns
    where table_schema = current_schema() and table_name = ${tableName}
  `.execute(db)
  const present = new Set(rows.map((r) => r.column_name))
  return TASK_TABLE_COLUMNS.filter((c) => !present.has(c))
}

/** Ширина varchar у `id`/`context_id`. */
export async function idColumnWidths(db: AnyDb, tableName: string): Promise<Record<string, number>> {
  const { rows } = await sql<{ column_name: string; width: number | null }>`
    select column_name, character_maximum_length as width from information_schema.columns
    where table_schema = current_schema() and table_name = ${tableName}
      and column_name in ('id', 'context_id')
  `.execute(db)
  return Object.fromEntries(rows.map((r) => [r.column_name, r.width ?? MAX_ID_LENGTH]))
}

/**
 * Падает, если таблица `tableName` есть, но это не таблица задач A2A. Проверка по набору колонок:
 * по одному имени чужая таблица (старая схема сервиса, таблица python-host или другого компонента в
 * общей базе) сошла бы за готовую. Урок minstroy: старая `a2a_tasks` с другой схемой.
 */
export async function assertNotForeignTable(db: AnyDb, tableName: string): Promise<void> {
  const missing = await missingTaskColumns(db, tableName)
  if (missing.length > 0) {
    throw new TaskStoreSchemaError(
      `table ${tableName} exists but is not an A2A task table of @a2a-js/sdk ` +
        `(missing columns: ${missing.join(', ')}). Another table already uses this name: ` +
        'drop or rename it, or pick a different table (--table).',
    )
  }
}

export interface CheckTaskStoreSchemaOptions {
  /**
   * Схему ведёт сам сервис (например, Prisma-миграцией в базе chat-backend), а не `a2a-db`: журнала
   * миграций `a2a_<table>_migrations` нет и не будет. Проверяются только таблица, колонки и ширина
   * id. Будущую миграцию upstream такой сервис повторяет своей миграцией, иначе старт упадёт на
   * проверке колонок.
   */
  externalSchema?: boolean
}

/**
 * Схема готова к работе: таблица есть, это таблица задач A2A, её создал `a2a-db` (есть журнал
 * миграций; при `externalSchema` не требуется), `id`/`context_id` шириной 255. Иначе —
 * `TaskStoreSchemaError` с подсказкой.
 */
export async function checkTaskStoreSchema(
  db: AnyDb,
  tableName: string = TASK_TABLE_NAME,
  opts: CheckTaskStoreSchemaOptions = {},
): Promise<void> {
  const hint = opts.externalSchema
    ? 'The schema is managed by the service (TASK_STORE_EXTERNAL_SCHEMA): apply its own migrations.'
    : 'Run `ai37-agent-host-task-store migrate` first.'
  if (!(await tableExists(db, tableName))) {
    throw new TaskStoreSchemaError(`table ${tableName} not found. ${hint}`)
  }
  await assertNotForeignTable(db, tableName)
  if (!opts.externalSchema && !(await tableExists(db, ledgerTableFor(tableName)))) {
    throw new TaskStoreSchemaError(
      `table ${tableName} has no migration ledger ${ledgerTableFor(tableName)}: ` +
        `it was not created by a2a-db. ${hint}`,
    )
  }
  const widths = await idColumnWidths(db, tableName)
  const narrow = Object.entries(widths).filter(([, width]) => width < MAX_ID_LENGTH)
  if (narrow.length > 0) {
    const list = narrow.map(([name, width]) => `${name}=${width}`).join(', ')
    throw new TaskStoreSchemaError(
      `table ${tableName}: id columns too narrow (${list}), expected ${MAX_ID_LENGTH}. ${hint}`,
    )
  }
}
