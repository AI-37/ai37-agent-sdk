import express, { type Express } from 'express'
import { AGENT_CARD_PATH, type AgentCard } from '@a2a-js/sdk'
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server'
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express'
import type { AgentContextSettings } from '@ai37/agent-sdk'
import { jwtGuard } from './auth-guard'
import { HostExecutor } from './a2a-executor'
import { aguiRouter } from './agui'
import type { AgentHandler } from './types'

export interface AgentHostOptions {
  /** AgentCard (discovery). */
  card: AgentCard
  /** Когниция агента (intent/work/critic/respond внутри). */
  handler: AgentHandler
  /** Настройки auth/billing для @ai37/agent-sdk AgentContext. */
  agentContext: AgentContextSettings
  /** Базовый путь A2A JSON-RPC. По умолчанию '/a2a/v1'. */
  basePath?: string
  /** Объект для /health и /version. */
  buildInfo?: Record<string, unknown>
}

/**
 * Собирает HTTP-приложение агента: health/version + agent-card + A2A JSON-RPC +
 * AG-UI SSE, всё за JWT-guard'ом (verified AgentContext в request-scope).
 * Новый агент = `createAgentHost({ card, handler, agentContext })`.
 */
export function createAgentHost(opts: AgentHostOptions): Express {
  const app = express()
  app.use(express.json())

  const info = opts.buildInfo ?? {}
  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', ...info })
  })
  app.get('/api/v1/version', (_req, res) => {
    res.json(info)
  })

  // TODO(state): InMemoryTaskStore → персистентный стор для HITL/тредов.
  const requestHandler = new DefaultRequestHandler(
    opts.card,
    new InMemoryTaskStore(),
    new HostExecutor(opts.handler),
  )

  app.use(
    `/${AGENT_CARD_PATH}`,
    agentCardHandler({ agentCardProvider: requestHandler }),
  )

  const required = opts.agentContext.auth.required ?? true
  const guard = jwtGuard(opts.agentContext, required)
  const base = opts.basePath ?? '/a2a/v1'

  app.use(
    base,
    guard,
    jsonRpcHandler({
      requestHandler,
      userBuilder: UserBuilder.noAuthentication, // auth делает guard (ALS)
    }),
  )

  app.use('/agui', guard, aguiRouter(opts.handler))

  return app
}
