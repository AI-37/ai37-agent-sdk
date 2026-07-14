// @ai37/agent-host — публичная точка входа.
export { createAgentHost } from './createAgentHost'
export type { AgentHostOptions } from './createAgentHost'
export {
  currentCtx,
  currentBearer,
  currentAcceptedOutputModes,
  currentSupportedCatalogIds,
  currentPartnerInstructions,
  withPartnerInstructions,
  currentTraceId,
  currentLangfuseTrace,
  currentLangfuseHandler,
  currentLangfuseCallbacks,
  requestScope,
} from './als'
export type { HostScope, HostLangfuseScope } from './als'
// Langfuse-наблюдаемость (v4/OTel): host сам открывает turn-спан хода; эти хелперы — для ручного
// контроля/тестов. `injectTraceContext` форвардит W3C trace-context вниз по A2A.
export {
  withTurnObservability,
  injectTraceContext,
  withRemoteA2aObservability,
  isLangfuseEnabled,
} from './observability/langfuse'
export type { BeginTurnArgs } from './observability/langfuse'
// LLM-модель без локального tiktoken-подсчёта токенов (см. ai37-chat-completions). Требует
// @langchain/openai у консьюмера (optional peer).
export { Ai37ChatCompletions } from './ai37-chat-completions'
export { jwtGuard } from './auth-guard'
// MCP «экспорт»: агент как MCP Resource Server (StreamableHTTP + OAuth-discovery). Низкоуровневые
// примитивы (buildMcpServer/protectedResourceMetadataRouter) — для потребителей вне agent-host
// (напр. NestJS rag-factory со своим guard'ом).
export {
  mountMcp,
  deriveAuthorizationServers,
  MCP_PATH,
  buildMcpServer,
  mcpHttpHandler,
  mcpChallengeGuard,
  protectedResourceMetadataRouter,
  protectedResourceMetadataUrl,
  bridgeHandlerToMcpTool,
} from './mcp'
export type {
  McpOptions,
  McpToolDef,
  McpToolResult,
  McpToolSet,
  McpToolsResolver,
  MountMcpOptions,
  ProtectedResourceMetadataOptions,
  BridgeToolOptions,
} from './mcp'
export { parseA2AMessage } from './parse'
export type { ParsedMessage } from './parse'
export { toTask, agentMessage } from './build-task'
export { HostExecutor } from './a2a-executor'
export { aguiRouter } from './agui'
export { componentToA2uiOperations, toA2uiSnapshot } from './a2ui'
export type { A2uiMessage } from './a2ui'
// StoreBackend для агентов: read-доступ к истории чатов/проектов через deepagents CompositeBackend.
export { ChatStoreBackend } from './store-backend/chat-store-backend'
export type { ChatStoreBackendOptions } from './store-backend/chat-store-backend'
// StoreBackend'ы вложений (файлы → markdown): эфемерные chat- и durable project-attachments.
export {
  ChatAttachmentsStoreBackend,
  ProjectAttachmentsStoreBackend,
} from './store-backend/attachments-store-backend'
export type {
  ChatAttachmentsStoreBackendOptions,
  ProjectAttachmentsStoreBackendOptions,
} from './store-backend/attachments-store-backend'
// File-aware примитив: манифест context_files в промпт + маппинг ref→путь (read/grep). Generic.
export { renderContextFilesManifest, contextFilePath } from './store-backend/file-context'
export type {
  StoreBackend,
  FileInfo,
  GrepMatch,
  LsResult,
  GlobResult,
  ReadResult,
  GrepResult,
  WriteResult,
  EditResult,
} from './store-backend/types'
// content-negotiation вывода (host-only): негоциация каталогов/текста + enforcement.
export {
  negotiateText,
  negotiateCatalog,
  negotiateCatalogs,
  negotiateOutput,
  readClientCapabilities,
  clientSupportsCatalog,
  filterA2uiComponents,
  filterA2uiByCatalog,
  A2UI_CAPABILITIES_VERSION,
} from './output-modes'
export type {
  OutputNegotiation,
  NegotiateOutputArgs,
  A2uiClientCapabilities,
} from './output-modes'
export type {
  AgentChannel,
  IntentEnvelope,
  Ai37Metadata,
  ContextFile,
  A2uiComponent,
  A2uiAction,
  A2uiDataPatch,
  A2uiSnapshot,
  AgentStatus,
  AgentInput,
  AgentEvent,
  AgentResult,
  AgentRequest,
  AgentHandler,
} from './types'
