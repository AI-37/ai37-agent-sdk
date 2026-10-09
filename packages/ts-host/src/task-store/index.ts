// @ai37/agent-host/task-store — durable A2A TaskStore на Postgres поверх upstream `DatabaseTaskStore`
// (@a2a-js/sdk 1.x) + схема (migrate/check) и ретенция. Тянет `kysely` и `pg` (optional peers):
// агенту без Postgres этот subpath не нужен.
export {
  Ai37TaskStore,
  TERMINAL_TASK_STATES,
  assertTaskStoreReady,
  createPostgresKysely,
  createPostgresPool,
  createTaskStoreFromEnv,
} from './store'
export type { Ai37TaskStoreOptions, CleanupOptions, CleanupResult } from './store'
export { migrateTaskStore } from './migrate'
export {
  MAX_ID_LENGTH,
  TASK_TABLE_COLUMNS,
  TASK_TABLE_NAME,
  TaskStoreSchemaError,
  checkTaskStoreSchema,
  ledgerTableFor,
} from './schema'
