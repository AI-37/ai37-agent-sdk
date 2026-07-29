export {
  A2A_PROTOCOL_VERSION,
  buildA2AAuthHeaders,
  forwardAuthFetch,
} from './forward'
export type { ForwardAuthOptions } from './forward'
export {
  AI37_ROUTING_EXTENSION_URI,
  AI37_ROUTING_INTENTS,
  buildAgentRoutingExtension,
  normalizeAgentRoutingProfile,
  parseAgentRoutingExtension,
} from './routing'
export type {
  AgentRoutingExtension,
  AgentRoutingIntent,
  AgentRoutingProfile,
} from './routing'
