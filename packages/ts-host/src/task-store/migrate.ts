import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { sql, type Kysely } from 'kysely'
import {
  MAX_ID_LENGTH,
  TASK_TABLE_NAME,
  TaskStoreSchemaError,
  assertNotForeignTable,
  checkTaskStoreSchema,
  idColumnWidths,
  tableExists,
} from './schema'

const run = promisify(execFile)

/**
 * Путь к CLI `a2a-db` из установленного `@a2a-js/sdk`. Бинарь ставится вместе с SDK, но в `exports`
 * его нет, а `node_modules/.bin` у потребителя не гарантирован, поэтому ищем его рядом с
 * `server/database`.
 */
function a2aDbBin(): string {
  const req = createRequire(import.meta.url)
  const entry = req.resolve('@a2a-js/sdk/server/database') // …/dist/server/database/index.cjs
  return join(dirname(entry), '..', '..', 'cli', 'a2a_db.js')
}

/**
 * Схема стора задач, идемпотентно; параллельные запуски (реплики initContainer) разводит лок
 * мигратора `a2a-db` (`a2a_migrations_lock`).
 *
 * 1. Чужая таблица с тем же именем → `TaskStoreSchemaError`, база не меняется.
 * 2. `a2a-db upgrade --store tasks --tasks-table-name <table>`: таблица, индексы и журнал
 *    `a2a_<table>_migrations` — SQL upstream, своего не пишем.
 * 3. `id`/`context_id` → `varchar(255)` (upstream — 36, наши `th_<uuid>` — 39). Collation `"C"` как
 *    у upstream, иначе `ALTER` сбросил бы её на дефолтную.
 * 4. `checkTaskStoreSchema`.
 *
 * Строка подключения уходит в `a2a-db` переменной окружения, не аргументом (не светится в `ps`).
 */
export async function migrateTaskStore(
  db: Kysely<any>,
  databaseUrl: string,
  tableName: string = TASK_TABLE_NAME,
): Promise<void> {
  if (await tableExists(db, tableName)) await assertNotForeignTable(db, tableName)

  try {
    await run(
      process.execPath,
      [a2aDbBin(), 'upgrade', '--store', 'tasks', '--tasks-table-name', tableName],
      { env: { ...process.env, DATABASE_URL: databaseUrl }, timeout: 120_000 },
    )
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? '').trim()
    throw new TaskStoreSchemaError(`a2a-db upgrade failed: ${stderr || String(e)}`)
  }

  const widths = await idColumnWidths(db, tableName)
  if (Object.values(widths).some((w) => w < MAX_ID_LENGTH)) {
    const width = sql.raw(`varchar(${MAX_ID_LENGTH}) collate "C"`)
    await sql`alter table ${sql.table(tableName)}
      alter column id type ${width}, alter column context_id type ${width}`.execute(db)
  }
  await checkTaskStoreSchema(db, tableName)
}
