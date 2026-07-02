// MCP Resource Server слой agent-host: превращает агента в MCP-сервер (StreamableHTTP) с
// OAuth-discovery (protected-resource-metadata) и той же проверкой токена, что A2A/AG-UI.
export type {
  McpOptions,
  McpToolDef,
  McpToolResult,
  McpToolsResolver,
} from './types'
export {
  protectedResourceMetadataRouter,
  protectedResourceMetadataUrl,
  type ProtectedResourceMetadataOptions,
} from './resource-metadata'
export { mcpChallengeGuard } from './challenge-guard'
export { buildMcpServer, mcpHttpHandler } from './mcp-server'
export { bridgeHandlerToMcpTool, type BridgeToolOptions } from './bridge'
export {
  mountMcp,
  deriveAuthorizationServers,
  MCP_PATH,
  type MountMcpOptions,
} from './mount'
