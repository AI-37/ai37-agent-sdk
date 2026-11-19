import { canonicalLocaleTag, localeVariantChain } from '../locale'
import { compactText } from './text'

/**
 * Versioned identifier for the AI37 Agent Card routing extension.
 * It is a namespace, not an endpoint: consumers must not dereference it.
 */
export const AI37_ROUTING_EXTENSION_URI =
  'https://schemas.ai37.ru/a2a/extensions/routing/v1' as const

/**
 * Operation intents for routing/v1. Continuation of an open HITL/wizard is orchestrator
 * workflow state (`mode=continuation`), not an intent advertised on Agent Cards.
 */
export const AI37_ROUTING_INTENTS = [
  'document_search',
  'document_list',
  'normative_qa',
  'exact_clause_lookup',
  'engineering_calculation',
  'parameter_selection',
  'counterparty_verification',
  'file_processing',
  'document_generation',
] as const

export type AgentRoutingIntent = (typeof AI37_ROUTING_INTENTS)[number]

/**
 * Domains and excludes in one more language. Intents are codes and are not translated. A request in
 * Spanish does not contain the Russian exclude phrase, so without a translation the guard silently
 * stops working (docs#589 §3.5).
 */
export interface AgentRoutingVariant {
  domains?: string[]
  excludes?: string[]
}

export interface AgentRoutingProfile extends Record<string, unknown> {
  /** Base phrases are Russian: consumers that know nothing about `i18n` keep using them as before. */
  domains: string[]
  intents: AgentRoutingIntent[]
  excludes: string[]
  /**
   * BCP-47 tag (canonical case after normalisation) → translation. Merge one in with
   * {@link localizeAgentRoutingProfile}.
   */
  i18n?: Record<string, AgentRoutingVariant>
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
  locales: 16,
} as const

const allowedIntents = new Set<string>(AI37_ROUTING_INTENTS)

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

/** A malformed translated list is dropped on its own: it must not cost the agent its routing. */
function normalizeVariantStrings(value: unknown, field: 'domains' | 'excludes'): string[] {
  if (value === undefined) return []
  try {
    return normalizeStrings(value, field)
  } catch {
    return []
  }
}

function normalizeVariant(value: unknown): AgentRoutingVariant | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const variant: AgentRoutingVariant = {}
  const domains = normalizeVariantStrings(raw.domains, 'domains')
  if (domains.length) variant.domains = domains
  const excludes = normalizeVariantStrings(raw.excludes, 'excludes')
  if (excludes.length) variant.excludes = excludes
  return Object.keys(variant).length ? variant : undefined
}

/**
 * Unlike the base lists, translations are lenient: the field is optional and additive, and a broken
 * translation should cost only itself, not the whole profile. Keys come out in canonical case.
 */
function normalizeI18n(value: unknown): Record<string, AgentRoutingVariant> {
  const result: Record<string, AgentRoutingVariant> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(result).length >= limits.locales) break
    const tag = canonicalLocaleTag(key)
    const variant = tag && !(tag in result) ? normalizeVariant(raw) : undefined
    if (tag && variant) result[tag] = variant
  }
  return result
}

export function normalizeAgentRoutingProfile(value: unknown): AgentRoutingProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('routing profile must be an object')
  }
  const profile = value as Record<string, unknown>
  const normalized: AgentRoutingProfile = {
    domains: normalizeStrings(profile.domains, 'domains'),
    intents: normalizeIntents(profile.intents),
    excludes: normalizeStrings(profile.excludes, 'excludes'),
  }
  const i18n = normalizeI18n(profile.i18n)
  if (Object.keys(i18n).length) normalized.i18n = i18n
  return normalized
}

/** Base first, then translations; a phrase repeated in another case is kept once. */
function mergePhrases(lists: readonly (readonly string[] | undefined)[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const phrase of lists.flatMap((list) => list ?? [])) {
    const key = phrase.toLocaleLowerCase('ru')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(phrase)
  }
  return result
}

/**
 * The profile for a turn in the given language: the Russian base plus the translations along
 * {@link localeVariantChain} (`es-MX` → `es-MX` and `es`). The base stays because users mix
 * languages and the planner prompt is Russian; a translation only adds phrases, it never removes an
 * exclude. A language without a translation gets the base as is. The result has no `i18n`.
 *
 * Expects a normalised profile — its translation keys are already in canonical case.
 */
export function localizeAgentRoutingProfile(
  profile: AgentRoutingProfile,
  locale: string | undefined,
): AgentRoutingProfile {
  const { i18n, ...base } = profile
  const variants = localeVariantChain(locale)
    .map((tag) => i18n?.[tag])
    .filter((variant): variant is AgentRoutingVariant => variant !== undefined)
  return {
    ...base,
    domains: mergePhrases([base.domains, ...variants.map((v) => v.domains)]),
    excludes: mergePhrases([base.excludes, ...variants.map((v) => v.excludes)]),
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
