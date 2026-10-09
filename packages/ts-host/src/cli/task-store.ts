import { parseArgs } from 'node:util'
import { Ai37TaskStore, createPostgresKysely, externalSchemaFromEnv } from '../task-store/store'
import { migrateTaskStore } from '../task-store/migrate'
import { TASK_TABLE_NAME, TaskStoreSchemaError, checkTaskStoreSchema } from '../task-store/schema'

const USAGE = `ai37-agent-host-task-store — схема и ретенция A2A TaskStore на Postgres

Использование:
  ai37-agent-host-task-store migrate  [--table a2a_tasks]
  ai37-agent-host-task-store check    [--table a2a_tasks]
  ai37-agent-host-task-store cleanup  [--table a2a_tasks] [--terminal-days 7] [--stale-days 14 | --keep-stale] [--batch-size 1000]

Строка подключения — только из DATABASE_URL. TASK_STORE_EXTERNAL_SCHEMA=true — схему ведёт сам сервис
(Prisma-миграция): check и cleanup не требуют журнала a2a-db, migrate отказывается.

  migrate   чужая таблица с тем же именем → отказ; a2a-db upgrade --store tasks; id/context_id → varchar(255); check
  check     таблица есть, это таблица задач A2A от a2a-db, id/context_id шириной 255 (иначе exit 1)
  cleanup   завершённые задачи старше --terminal-days, незавершённые старше --stale-days (≥ terminal);
            --keep-stale — незавершённые не трогать. Строки без таймстемпа не удаляются.`

export interface CliIo {
  env: NodeJS.ProcessEnv
  out: (line: string) => void
  err: (line: string) => void
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`--${name} must be a positive integer`)
  return value
}

async function runCommand(
  command: string,
  values: Record<string, string | boolean | undefined>,
  url: string,
  externalSchema: boolean,
): Promise<string> {
  const table = (values.table as string | undefined) ?? TASK_TABLE_NAME
  if (command === 'migrate' && externalSchema) {
    // a2a-db upgrade полез бы в таблицу, которую создал и ведёт сервис, и завёл бы рядом свой журнал.
    throw new TaskStoreSchemaError(
      'migrate is disabled: TASK_STORE_EXTERNAL_SCHEMA=true, the schema is managed by the service',
    )
  }
  const db = createPostgresKysely(url, 1)
  try {
    if (command === 'migrate') {
      await migrateTaskStore(db, url, table)
      return `ai37 task store: table ${table} ready`
    }
    if (command === 'check') {
      await checkTaskStoreSchema(db, table, { externalSchema })
      return `ai37 task store: ok (${table})`
    }
    const terminalDays = positiveInt('terminal-days', values['terminal-days'] as string | undefined, 7)
    const staleDays = values['keep-stale']
      ? undefined
      : positiveInt('stale-days', values['stale-days'] as string | undefined, 14)
    const batchSize = positiveInt('batch-size', values['batch-size'] as string | undefined, 1000)
    const store = new Ai37TaskStore(db, { tableName: table, externalSchema })
    await store.assertReady()
    const result = await store.cleanup({ terminalDays, staleDays, batchSize })
    return (
      `ai37 task store: deleted ${result.terminalDeleted} terminal (>${terminalDays}d), ` +
      `${result.staleDeleted} stale (${staleDays === undefined ? 'kept' : `>${staleDays}d`})`
    )
  } finally {
    await db.destroy()
  }
}

/** CLI `migrate | check | cleanup`. Возвращает код выхода: 0 — ок, 1 — ошибка, 2 — неверный вызов. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        table: { type: 'string' },
        'terminal-days': { type: 'string' },
        'stale-days': { type: 'string' },
        'keep-stale': { type: 'boolean' },
        'batch-size': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (e) {
    io.err(`ai37 task store: ${(e as Error).message}\n\n${USAGE}`)
    return 2
  }
  const [command] = parsed.positionals
  if (parsed.values.help || !command) {
    io.out(USAGE)
    return parsed.values.help ? 0 : 2
  }
  if (!['migrate', 'check', 'cleanup'].includes(command)) {
    io.err(`ai37 task store: unknown command "${command}"\n\n${USAGE}`)
    return 2
  }
  const url = io.env.DATABASE_URL
  if (!url) {
    io.err('ai37 task store: DATABASE_URL is not set')
    return 1
  }
  try {
    io.out(
      await runCommand(
        command,
        parsed.values as Record<string, string | boolean | undefined>,
        url,
        externalSchemaFromEnv(io.env),
      ),
    )
    return 0
  } catch (e) {
    // Схема не та или не готова, неверные дни — понятное сообщение без стектрейса. Прочее (сеть,
    // права) — тоже одной строкой: строку подключения pg в текст ошибки не кладёт.
    const message = e instanceof TaskStoreSchemaError || e instanceof RangeError ? e.message : String(e)
    io.err(`ai37 task store: ${message}`)
    return 1
  }
}
