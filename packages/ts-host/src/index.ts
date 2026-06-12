// @ai37/agent-host — публичная точка входа.
export { createAgentHost } from './createAgentHost'
export type { AgentHostOptions } from './createAgentHost'
export { currentCtx, currentBearer, requestScope } from './als'
export type { HostScope } from './als'
export { jwtGuard } from './auth-guard'
export { parseA2AMessage } from './parse'
export type { ParsedMessage } from './parse'
export { toTask, agentMessage } from './build-task'
export { HostExecutor } from './a2a-executor'
export { aguiRouter } from './agui'
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
