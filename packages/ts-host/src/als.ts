import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentContext } from '@ai37/agent-sdk'

/**
 * Request-scope: JWT-guard кладёт сюда verified `AgentContext`, executor/handler
 * читают, не завязываясь на внутренний auth-API `@a2a-js/sdk`.
 */
export interface HostScope {
  ctx?: AgentContext
  bearer?: string
  /**
   * `acceptedOutputModes` (формат текста) из нативного A2A `params.configuration`.
   * Guard читает его из тела JSON-RPC в express-слое, т.к. `@a2a-js/sdk` НЕ пробрасывает
   * `configuration` в `RequestContext` исполнителя. На AG-UI-пути дополняется роутером из
   * `forwardedProps.ai37.acceptedOutputModes`.
   */
  acceptedOutputModes?: string[]
  /**
   * `supportedCatalogIds` (каталоги A2UI) из `a2uiClientCapabilities.v0.9` — для A2A из
   * `message.metadata`, для AG-UI из `forwardedProps.a2uiClientCapabilities`. В ALS, чтобы
   * downstream (оркестратор → remote-агенты) форвардил их так же, как `currentBearer`.
   */
  supportedCatalogIds?: string[]
}

export const requestScope = new AsyncLocalStorage<HostScope>()

export const currentCtx = (): AgentContext | undefined =>
  requestScope.getStore()?.ctx

export const currentBearer = (): string | undefined =>
  requestScope.getStore()?.bearer

export const currentAcceptedOutputModes = (): string[] | undefined =>
  requestScope.getStore()?.acceptedOutputModes

export const currentSupportedCatalogIds = (): string[] | undefined =>
  requestScope.getStore()?.supportedCatalogIds
