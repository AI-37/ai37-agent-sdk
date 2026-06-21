/**
 * Type-only conformance: StoreBackend'ы ts-host должны быть совместимы с deepagents `BackendProtocolV2`
 * (их монтируют в `CompositeBackend` агентов). `import type` стирается компилятором → НЕТ рантайм-
 * зависимости от deepagents; ts-host остаётся развязанным и лёгким. Любой дрейф протокола (как
 * появление `readRaw`) ловится здесь — в сборке ts-host, а не у потребителей-агентов.
 *
 * Файл НЕ импортируется из index.ts → не попадает в dist; проверяется только при typecheck (`tsc`).
 */
import type { BackendProtocolV2 } from 'deepagents'
import type { StoreBackend } from './types'
import type { ChatStoreBackend } from './chat-store-backend'
import type {
  ChatAttachmentsStoreBackend,
  ProjectAttachmentsStoreBackend,
} from './attachments-store-backend'

/** Падает компиляцией, если T не подходит под BackendProtocolV2. */
type AssertBackend<T extends BackendProtocolV2> = T

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _Checks = [
  AssertBackend<StoreBackend>,
  AssertBackend<ChatStoreBackend>,
  AssertBackend<ChatAttachmentsStoreBackend>,
  AssertBackend<ProjectAttachmentsStoreBackend>,
]

export {}
