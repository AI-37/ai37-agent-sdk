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
   * `acceptedOutputModes` из нативного A2A `params.configuration` (content-negotiation).
   * Guard читает его из тела JSON-RPC в express-слое, т.к. `@a2a-js/sdk` НЕ пробрасывает
   * `configuration` в `RequestContext` исполнителя. Для AG-UI-пути не используется (там
   * accepted берётся из `forwardedProps.ai37` прямо в роутере).
   */
  acceptedOutputModes?: string[]
}

export const requestScope = new AsyncLocalStorage<HostScope>()

export const currentCtx = (): AgentContext | undefined =>
  requestScope.getStore()?.ctx

export const currentBearer = (): string | undefined =>
  requestScope.getStore()?.bearer

export const currentAcceptedOutputModes = (): string[] | undefined =>
  requestScope.getStore()?.acceptedOutputModes
