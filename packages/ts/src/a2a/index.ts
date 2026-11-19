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
  localizeAgentRoutingProfile,
  normalizeAgentRoutingProfile,
  parseAgentRoutingExtension,
} from './routing'
export type {
  AgentRoutingExtension,
  AgentRoutingIntent,
  AgentRoutingProfile,
  AgentRoutingVariant,
} from './routing'
export {
  AI37_SHOWCASE_EXTENSION_URI,
  buildAgentShowcaseExtension,
  localizeAgentShowcaseProfile,
  normalizeAgentShowcaseProfile,
  parseAgentShowcaseExtension,
} from './showcase'
export type {
  AgentShowcaseCapability,
  AgentShowcaseCapabilityVariant,
  AgentShowcaseExtension,
  AgentShowcaseNorm,
  AgentShowcaseProfile,
  AgentShowcaseVariant,
} from './showcase'
