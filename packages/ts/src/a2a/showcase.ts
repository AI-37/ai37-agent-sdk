import { compactText } from './text'

/**
 * Versioned identifier for the AI37 Agent Card showcase extension.
 * It is a namespace, not an endpoint: consumers must not dereference it.
 */
export const AI37_SHOWCASE_EXTENSION_URI =
  'https://schemas.ai37.ru/a2a/extensions/showcase/v1' as const

/**
 * A norm the agent computes by. `title` is the full name and is not printed everywhere:
 * compact cards show the code alone. An empty list means the agent cites no norms, and the surface
 * prints nothing: an invented reference is worse than a missing one, and «Норматив уточняется» on
 * an agent that checks counterparties would be a promise nobody intends to keep.
 */
export interface AgentShowcaseNorm {
  code: string
  title?: string
}

/**
 * One mode of the agent that the showcase draws as its own tile. It is a caption, not a skill, and
 * it does not route. A tile may point at one of the card's skills (`skill`): the catalog then shows
 * it only to organizations that pass that skill's gate (`x-ai37.skills[skill].billing`) on top of
 * the agent's own. The gate stays in one place, the card's billing block; the tile only refers to
 * it. Display order is the array order; there is no `order` field.
 */
export interface AgentShowcaseCapability {
  /** Slug `^[a-z0-9][a-z0-9-]{0,39}$`, unique within the agent: React key and analytics handle. */
  id: string
  title: string
  summary: string
  starter?: string
  examples?: string[]
  /**
   * Id of a skill in the same card (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`). The normalizer cannot see
   * the skills list, so it only checks the shape; whether the skill exists is the catalog's call.
   */
  skill?: string
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
  capabilities?: AgentShowcaseCapability[]
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
  capabilities: 6,
} as const

const CAPABILITY_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
// Skill ids are not slugs: Python agents name them `verify_single`, TS agents `document-search`.
const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/**
 * Unlike routing, showcase text is clamped instead of rejected: dropping a whole agent from the
 * catalog over a 61st character would cost the user more than an ellipsis does. The ellipsis is
 * deliberate — a truncated line must look truncated, not like the agent's real name.
 *
 * Length is counted in code points, not UTF-16 code units, so that a limit means the same thing
 * here and in the Python SDK (`len()` counts code points). `String.prototype.slice` would also cut
 * a surrogate pair in half and emit a lone surrogate — an invalid string travelling into the card's
 * JSON. Spreading into an array gives whole code points to slice on.
 */
function clampText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  const text = compactText(value)
  const points = [...text]
  if (points.length <= limit) return text
  return `${points.slice(0, limit - 1).join('').trimEnd()}…`
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

/** A capability without its own starter or examples is valid: the tile then shows text only. */
function normalizeCapability(value: unknown): AgentShowcaseCapability | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  // The id is not cleaned: surrounding whitespace means it is not a slug. Trimming would also make
  // the SDKs disagree on what whitespace is (`String.prototype.trim` vs Python `str.strip`).
  const id = typeof raw.id === 'string' ? raw.id : ''
  const title = clampText(raw.title, limits.title)
  const summary = clampText(raw.summary, limits.summary)
  if (!CAPABILITY_ID.test(id) || !title || !summary) return undefined
  return { id, title, summary, ...normalizeCapabilityOptionalFields(raw) }
}

function normalizeCapabilityOptionalFields(
  raw: Record<string, unknown>,
): Pick<AgentShowcaseCapability, 'starter' | 'examples' | 'skill'> {
  const optional: Pick<AgentShowcaseCapability, 'starter' | 'examples' | 'skill'> = {}
  const starter = clampText(raw.starter, limits.starter)
  if (starter) optional.starter = starter
  const examples = normalizeExamples(raw.examples)
  if (examples.length) optional.examples = examples
  // A malformed reference is dropped, the tile stays: showing it ungated beats losing it, and the
  // agent's own gate still applies. Not trimmed, for the same reason as the id.
  if (typeof raw.skill === 'string' && SKILL_ID.test(raw.skill)) optional.skill = raw.skill
  return optional
}

/**
 * A broken capability is dropped and the profile survives, the same way a malformed norm is: the
 * agent itself is still worth showing. A repeated `id` keeps the first occurrence.
 */
function normalizeCapabilities(value: unknown): AgentShowcaseCapability[] {
  if (!Array.isArray(value)) return []
  const result: AgentShowcaseCapability[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (result.length >= limits.capabilities) break
    const capability = normalizeCapability(item)
    if (!capability || seen.has(capability.id)) continue
    seen.add(capability.id)
    result.push(capability)
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
  const capabilities = normalizeCapabilities(profile.capabilities)
  if (capabilities.length) optional.capabilities = capabilities
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
