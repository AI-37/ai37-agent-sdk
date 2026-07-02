import type { Express } from 'express'
import type { AgentCard } from '@a2a-js/sdk'
import type {
  AgentContextOverrides,
  AgentContextSettings,
} from '@ai37/agent-sdk'
import {
  protectedResourceMetadataRouter,
  protectedResourceMetadataUrl,
} from './resource-metadata'
import { mcpChallengeGuard } from './challenge-guard'
import { mcpHttpHandler } from './mcp-server'
import type { McpOptions } from './types'

/** Путь MCP-эндпоинта (StreamableHTTP) на хосте. */
export const MCP_PATH = '/mcp'

/**
 * Authentik issuer(ы) из настроек auth → `authorization_servers` protected-resource-metadata.
 * Preferred — multi-issuer `issuers[].issuer`; иначе legacy single-issuer `auth.issuer`.
 */
export function deriveAuthorizationServers(
  auth: AgentContextSettings['auth'],
): string[] {
  if (auth.issuers?.length) return auth.issuers.map((i) => i.issuer)
  if (auth.issuer) return [auth.issuer]
  return []
}

export interface MountMcpOptions {
  card: AgentCard
  mcp: McpOptions
  agentContext: AgentContextSettings
  required: boolean
  overrides?: AgentContextOverrides
  buildInfo?: Record<string, unknown>
}

/**
 * Монтирует MCP Resource Server поверх express-приложения хоста: (1) publичный
 * protected-resource-metadata (discovery), (2) `/mcp` за `mcpChallengeGuard` (401+challenge +
 * проверка токена + ALS-scope), (3) StreamableHTTP-handler с резолвом tools. Публичный
 * MCP-URL — из `card.url` (тот же origin, что A2A-эндпоинт).
 */
export function mountMcp(app: Express, opts: MountMcpOptions): void {
  const origin = new URL(opts.card.url).origin
  const mcpUrl = `${origin}${MCP_PATH}`
  const resourceMetadataUrl = protectedResourceMetadataUrl(mcpUrl)
  const authorizationServers = deriveAuthorizationServers(
    opts.agentContext.auth,
  )

  app.use(
    protectedResourceMetadataRouter({
      resource: mcpUrl,
      authorizationServers,
      scopesSupported: opts.mcp.scopes,
      resourceName: opts.card.name,
    }),
  )

  const version =
    (opts.buildInfo?.version as string | undefined) ??
    opts.card.version ??
    '0.0.0'
  const serverInfo = {
    name: opts.mcp.serverName ?? opts.card.name,
    version,
  }

  app.all(
    MCP_PATH,
    mcpChallengeGuard(
      opts.agentContext,
      opts.required,
      resourceMetadataUrl,
      opts.overrides ?? {},
    ),
    mcpHttpHandler(opts.mcp, serverInfo),
  )
}
