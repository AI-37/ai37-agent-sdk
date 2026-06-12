import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentContext } from '@ai37/agent-sdk'

/**
 * Request-scope: JWT-guard кладёт сюда verified `AgentContext`, executor/handler
 * читают, не завязываясь на внутренний auth-API `@a2a-js/sdk`.
 */
export interface HostScope {
  ctx?: AgentContext
  bearer?: string
}

export const requestScope = new AsyncLocalStorage<HostScope>()

export const currentCtx = (): AgentContext | undefined =>
  requestScope.getStore()?.ctx

export const currentBearer = (): string | undefined =>
  requestScope.getStore()?.bearer
