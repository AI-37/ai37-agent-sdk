// MCP Resource Server слой agent-host: превращает агента в MCP-сервер (StreamableHTTP) с
// OAuth-discovery (protected-resource-metadata) и той же проверкой токена, что A2A/AG-UI.
export type {
  McpImageContent,
  McpOptions,
  McpResourceCsp,
  McpResourceDef,
  McpResourceUi,
  McpTextContent,
  McpToolAnnotations,
  McpToolDef,
  McpToolResult,
  McpToolSet,
  McpToolsResolver,
  McpToolUi,
  McpToolVisibility,
} from './types'
export { MCP_APP_MIME_TYPE, MCP_APP_RESOURCE_URI_META_KEY } from './types'
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
export {
  a2uiApp,
  a2uiViewUri,
  mcpBilling,
  type A2uiApp,
  type A2uiAppBilling,
  type A2uiAppNode,
  type A2uiAppOptions,
  type A2uiStep,
  type McpBilling,
} from './a2ui-app'
