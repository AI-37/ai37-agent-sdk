import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'

export interface CreateCheckpointerOptions {
  /**
   * Postgres connection string (durable графовое состояние). Пусто/undefined → in-memory (dev).
   * По конвенции экосистемы — СВОЯ БД на агента (не общая), чтобы не было гонок миграций схемы
   * между агентами: `PostgresSaver.setup()` создаёт свои таблицы в этой БД.
   */
  databaseUrl?: string
}

/**
 * Собирает LangGraph-чекпоинтер для durable графового состояния (по `thread_id`):
 *  - `databaseUrl` задан → `PostgresSaver.fromConnString(databaseUrl)` + `setup()` (создаёт таблицы
 *    `checkpoints`/`checkpoint_blobs`/`checkpoint_writes`/`checkpoint_migrations` при первом старте) —
 *    durable, переживает рестарт/мульти-под;
 *  - иначе → `MemorySaver` (dev): графовое состояние в памяти процесса, НЕ durable.
 *
 * Пакеты `@langchain/langgraph-checkpoint*` — OPTIONAL PEERS и импортируются ЛЕНИВО (dynamic import),
 * поэтому обычный `import '@ai37/agent-host'` их НЕ требует: ставит их только агент, который реально
 * зовёт `createCheckpointer` (calc-агенты без графа их не ставят). Возвращаемый saver передаётся
 * хосту как `AgentHostOptions.checkpointer` → ALS → `currentCheckpointer()`; когниция агента цепляет
 * его в свой граф (`graph.compile({ checkpointer })`).
 *
 * Ретенция старых тредов — НЕ здесь: её делает k8s CronJob (см. шаблон agent-template-js). `setup()`
 * идемпотентен — безопасно звать на каждом старте.
 */
export async function createCheckpointer(
  opts: CreateCheckpointerOptions = {},
): Promise<BaseCheckpointSaver> {
  const databaseUrl = opts.databaseUrl?.trim()
  if (!databaseUrl) {
    const { MemorySaver } = await import('@langchain/langgraph-checkpoint')
    return new MemorySaver()
  }
  const { PostgresSaver } = await import('@langchain/langgraph-checkpoint-postgres')
  const saver = PostgresSaver.fromConnString(databaseUrl)
  await saver.setup()
  return saver
}
