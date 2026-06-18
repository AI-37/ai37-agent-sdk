// @ai37/agent-host — публичная точка входа.
export { createAgentHost } from './createAgentHost'
export type { AgentHostOptions } from './createAgentHost'
export {
  currentCtx,
  currentBearer,
  currentAcceptedOutputModes,
  currentSupportedCatalogIds,
  requestScope,
} from './als'
export type { HostScope } from './als'
export { jwtGuard } from './auth-guard'
export { parseA2AMessage } from './parse'
export type { ParsedMessage } from './parse'
export { toTask, agentMessage } from './build-task'
export { HostExecutor } from './a2a-executor'
export { aguiRouter } from './agui'
export { componentToA2uiOperations } from './a2ui'
export type { A2uiMessage } from './a2ui'
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
  A2uiComponent,
  AgentStatus,
  AgentInput,
  AgentEvent,
  AgentResult,
  AgentRequest,
  AgentHandler,
} from './types'
