/**
 * Versioned identifier for the AI37 Agent Card routing extension.
 * It is a namespace, not an endpoint: consumers must not dereference it.
 */
export const AI37_ROUTING_EXTENSION_URI =
  'https://schemas.ai37.ru/a2a/extensions/routing/v1' as const

export const AI37_ROUTING_INTENTS = [
  'document_search',
  'document_list',
  'normative_qa',
  'exact_clause_lookup',
  'engineering_calculation',
  'parameter_selection',
  'counterparty_verification',
  'file_processing',
  'workflow_continue',
] as const

export type AgentRoutingIntent = (typeof AI37_ROUTING_INTENTS)[number]

export interface AgentRoutingProfile extends Record<string, unknown> {
  domains: string[]
  intents: AgentRoutingIntent[]
  excludes: string[]
}

export interface AgentRoutingExtension {
  uri: typeof AI37_ROUTING_EXTENSION_URI
  description: string
  required: false
  params: AgentRoutingProfile
}

const limits = {
  domains: { items: 12, length: 80 },
  intents: { items: 16 },
  excludes: { items: 12, length: 160 },
} as const

const allowedIntents = new Set<string>(AI37_ROUTING_INTENTS)

function compactText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  })
    .join('')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeStrings(
  value: unknown,
  field: 'domains' | 'excludes',
): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`routing.${field} must be an array`)
  }
  const limit = limits[field]
  if (value.length > limit.items) {
    throw new RangeError(`routing.${field} must contain at most ${limit.items} items`)
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new TypeError(`routing.${field} items must be strings`)
    }
    const normalized = compactText(item)
    if (!normalized || normalized.length > limit.length) {
      throw new RangeError(`routing.${field} items must be 1..${limit.length} characters`)
    }
    const key = normalized.toLocaleLowerCase('ru')
    if (!seen.has(key)) {
      seen.add(key)
      result.push(normalized)
    }
  }
  return result
}

function normalizeIntents(value: unknown): AgentRoutingIntent[] {
  if (!Array.isArray(value)) {
    throw new TypeError('routing.intents must be an array')
  }
  if (value.length > limits.intents.items) {
    throw new RangeError(`routing.intents must contain at most ${limits.intents.items} items`)
  }
  const result: AgentRoutingIntent[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !allowedIntents.has(item)) {
      throw new TypeError(`unsupported routing intent: ${String(item)}`)
    }
    if (!result.includes(item as AgentRoutingIntent)) {
      result.push(item as AgentRoutingIntent)
    }
  }
  return result
}

export function normalizeAgentRoutingProfile(value: unknown): AgentRoutingProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('routing profile must be an object')
  }
  const profile = value as Record<string, unknown>
  return {
    domains: normalizeStrings(profile.domains, 'domains'),
    intents: normalizeIntents(profile.intents),
    excludes: normalizeStrings(profile.excludes, 'excludes'),
  }
}

export function buildAgentRoutingExtension(
  profile: AgentRoutingProfile,
): AgentRoutingExtension {
  return {
    uri: AI37_ROUTING_EXTENSION_URI,
    description: 'Compact semantic routing profile for the AI37 agent registry.',
    required: false,
    params: normalizeAgentRoutingProfile(profile),
  }
}

export function parseAgentRoutingExtension(
  extensions: readonly unknown[] | null | undefined,
): AgentRoutingProfile | undefined {
  const extension = extensions?.find(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      (item as Record<string, unknown>).uri === AI37_ROUTING_EXTENSION_URI,
  ) as Record<string, unknown> | undefined
  if (!extension) return undefined
  try {
    return normalizeAgentRoutingProfile(extension.params)
  } catch {
    return undefined
  }
}
