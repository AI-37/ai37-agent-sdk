// @ai37/agent-host/relay — переносимая A2A-relay-механика (вызов другого агента + HITL-канал).
// Транспорт-агностично: НЕ тянет LangChain/deepagents/NestJS. Политику («кого звать») и durable-стор
// держит потребитель. Лист, не импортирующий этот subpath, не тянет @a2a-js/sdk/client в бандл.
export { executeRemoteA2a, executeRemoteA2aStreaming } from './execute'
export type {
  RemoteA2aRequest,
  RemoteA2aResult,
  RemoteA2aState,
  RemoteA2aProgressEvent,
} from './execute'
export { extractText, extractA2ui, isStaleTaskError } from './extract'
export {
  InMemoryRemoteTaskStore,
} from './task-store'
export type { RemoteTaskStore, RemoteTaskRef } from './task-store'
// Типы ядра реэкспортируем, чтобы потребитель брал их из одного места.
export type { A2uiComponent, A2uiAction, ContextFile } from '../types'
