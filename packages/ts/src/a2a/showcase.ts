import { compactText } from './text'

/**
 * Versioned identifier for the AI37 Agent Card showcase extension.
 * It is a namespace, not an endpoint: consumers must not dereference it.
 */
export const AI37_SHOWCASE_EXTENSION_URI =
  'https://schemas.ai37.ru/a2a/extensions/showcase/v1' as const

/**
 * A norm the agent computes by. `title` is the full name and is not printed everywhere:
 * compact cards show the code alone. An empty list means the surface writes «Норматив
 * уточняется» — an invented reference is worse than a missing one.
 */
export interface AgentShowcaseNorm {
  code: string
  title?: string
}

/** User-facing description of the agent for the product catalog (page and empty chat screen). */
export interface AgentShowcaseProfile extends Record<string, unknown> {
  title: string
  summary: string
  computes?: string
  norms?: AgentShowcaseNorm[]
  starter?: string
  examples?: string[]
  order?: number
}

export interface AgentShowcaseExtension {
  uri: typeof AI37_SHOWCASE_EXTENSION_URI
  description: string
  required: false
  params: AgentShowcaseProfile
}

const limits = {
  title: 60,
  summary: 160,
  computes: 240,
  starter: 160,
  norms: { items: 4, code: 80, title: 200 },
  examples: { items: 4, length: 160 },
} as const

/**
 * Unlike routing, showcase text is clamped instead of rejected: dropping a whole agent from the
 * catalog over a 61st character would cost the user more than an ellipsis does. The ellipsis is
 * deliberate — a truncated line must look truncated, not like the agent's real name.
 */
function clampText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  const text = compactText(value)
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1).trimEnd()}…`
}

function normalizeNorms(value: unknown): AgentShowcaseNorm[] {
  if (!Array.isArray(value)) return []
  const result: AgentShowcaseNorm[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (result.length >= limits.norms.items) break
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const raw = item as Record<string, unknown>
    const code = clampText(raw.code, limits.norms.code)
    const key = code.toLocaleLowerCase('ru')
    if (!code || seen.has(key)) continue
    seen.add(key)
    const title = clampText(raw.title, limits.norms.title)
    result.push(title ? { code, title } : { code })
  }
  return result
}

function normalizeExamples(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (result.length >= limits.examples.items) break
    const example = clampText(item, limits.examples.length)
    const key = example.toLocaleLowerCase('ru')
    if (!example || seen.has(key)) continue
    seen.add(key)
    result.push(example)
  }
  return result
}

/** Optional fields are omitted rather than emitted empty: the card stays readable as JSON. */
function normalizeOptionalFields(
  profile: Record<string, unknown>,
): Omit<AgentShowcaseProfile, 'title' | 'summary'> {
  const optional: Omit<AgentShowcaseProfile, 'title' | 'summary'> = {}
  const computes = clampText(profile.computes, limits.computes)
  if (computes) optional.computes = computes
  const norms = normalizeNorms(profile.norms)
  if (norms.length) optional.norms = norms
  const starter = clampText(profile.starter, limits.starter)
  if (starter) optional.starter = starter
  const examples = normalizeExamples(profile.examples)
  if (examples.length) optional.examples = examples
  if (typeof profile.order === 'number' && Number.isInteger(profile.order)) {
    optional.order = profile.order
  }
  return optional
}

/**
 * Throws only when there is nothing to show: a card that declares the extension without a title or
 * a summary has no place in the catalog, and the agent should learn that on its own CI. Everything
 * else is clamped or dropped.
 */
export function normalizeAgentShowcaseProfile(value: unknown): AgentShowcaseProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('showcase profile must be an object')
  }
  const profile = value as Record<string, unknown>
  const title = clampText(profile.title, limits.title)
  const summary = clampText(profile.summary, limits.summary)
  if (!title || !summary) {
    throw new TypeError('showcase.title and showcase.summary are required')
  }
  return { title, summary, ...normalizeOptionalFields(profile) }
}

export function buildAgentShowcaseExtension(
  profile: AgentShowcaseProfile,
): AgentShowcaseExtension {
  return {
    uri: AI37_SHOWCASE_EXTENSION_URI,
    description: 'User-facing showcase profile for the AI37 agent catalog.',
    required: false,
    params: normalizeAgentShowcaseProfile(profile),
  }
}

export function parseAgentShowcaseExtension(
  extensions: readonly unknown[] | null | undefined,
): AgentShowcaseProfile | undefined {
  const extension = extensions?.find(
    (item) =>
      !!item &&
      typeof item === 'object' &&
      (item as Record<string, unknown>).uri === AI37_SHOWCASE_EXTENSION_URI,
  ) as Record<string, unknown> | undefined
  if (!extension) return undefined
  try {
    return normalizeAgentShowcaseProfile(extension.params)
  } catch {
    return undefined
  }
}
