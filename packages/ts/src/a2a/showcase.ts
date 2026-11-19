import { canonicalLocaleTag, localeVariantChain } from '../locale'
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

/**
 * Translation of one capability tile, matched to the base tile by `id`. The gate (`skill`) is not
 * translated: it lives on the base tile only.
 */
export interface AgentShowcaseCapabilityVariant {
  id: string
  title?: string
  summary?: string
  starter?: string
  examples?: string[]
}

/**
 * Translation of the showcase into one language. Every field is optional: a missing one falls back
 * along the locale chain and then to the Russian base. Norms are not here on purpose — a norm is
 * cited in its original language (docs#589 §1).
 */
export interface AgentShowcaseVariant {
  title?: string
  summary?: string
  computes?: string
  starter?: string
  examples?: string[]
  capabilities?: AgentShowcaseCapabilityVariant[]
}

/** User-facing description of the agent for the product catalog (page and empty chat screen). */
export interface AgentShowcaseProfile extends Record<string, unknown> {
  /** Base text is Russian: consumers that know nothing about `i18n` keep showing it as before. */
  title: string
  summary: string
  computes?: string
  norms?: AgentShowcaseNorm[]
  starter?: string
  examples?: string[]
  order?: number
  capabilities?: AgentShowcaseCapability[]
  /**
   * BCP-47 tag (canonical case after normalisation) → translation. Pick one with
   * {@link localizeAgentShowcaseProfile}.
   */
  i18n?: Record<string, AgentShowcaseVariant>
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
  locales: 16,
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

type VariantText = Omit<AgentShowcaseVariant, 'capabilities'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Text fields shared by a translation and its tiles; absent or empty ones are not emitted. */
function normalizeVariantText(raw: Record<string, unknown>): VariantText {
  const text: VariantText = {}
  const title = clampText(raw.title, limits.title)
  if (title) text.title = title
  const summary = clampText(raw.summary, limits.summary)
  if (summary) text.summary = summary
  const starter = clampText(raw.starter, limits.starter)
  if (starter) text.starter = starter
  const examples = normalizeExamples(raw.examples)
  if (examples.length) text.examples = examples
  return text
}

/** A tile translation for a tile the base does not have is dropped: there is nothing to translate. */
function normalizeCapabilityVariants(
  value: unknown,
  baseIds: readonly string[],
): AgentShowcaseCapabilityVariant[] {
  if (!Array.isArray(value)) return []
  const result: AgentShowcaseCapabilityVariant[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string') continue
    const id = item.id
    if (!baseIds.includes(id) || result.some((c) => c.id === id)) continue
    const text = normalizeVariantText(item)
    if (Object.keys(text).length) result.push({ id, ...text })
  }
  return result
}

function normalizeVariant(
  value: unknown,
  baseIds: readonly string[],
): AgentShowcaseVariant | undefined {
  if (!isRecord(value)) return undefined
  const variant: AgentShowcaseVariant = normalizeVariantText(value)
  const computes = clampText(value.computes, limits.computes)
  if (computes) variant.computes = computes
  const capabilities = normalizeCapabilityVariants(value.capabilities, baseIds)
  if (capabilities.length) variant.capabilities = capabilities
  return Object.keys(variant).length ? variant : undefined
}

/**
 * Translations are optional and additive: a key that is not a BCP-47 tag or an empty translation is
 * dropped, the base profile survives. Keys come out in canonical case (`es-mx` → `es-MX`).
 */
function normalizeI18n(
  value: unknown,
  baseIds: readonly string[],
): Record<string, AgentShowcaseVariant> {
  const result: Record<string, AgentShowcaseVariant> = {}
  if (!isRecord(value)) return result
  for (const [key, raw] of Object.entries(value)) {
    if (Object.keys(result).length >= limits.locales) break
    const tag = canonicalLocaleTag(key)
    const variant = tag && !(tag in result) ? normalizeVariant(raw, baseIds) : undefined
    if (tag && variant) result[tag] = variant
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
  const i18n = normalizeI18n(profile.i18n, capabilities.map((c) => c.id))
  if (Object.keys(i18n).length) optional.i18n = i18n
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

/** The first translation along the chain that has the field, or `undefined`. */
function firstText<K extends keyof VariantText>(
  variants: readonly VariantText[],
  field: K,
): VariantText[K] {
  return variants.find((variant) => variant[field] !== undefined)?.[field]
}

function overlayText<T extends VariantText>(base: T, variants: readonly VariantText[]): T {
  const result = { ...base }
  for (const field of ['title', 'summary', 'computes', 'starter', 'examples'] as const) {
    const value = firstText(variants, field)
    if (value !== undefined) Object.assign(result, { [field]: value })
  }
  return result
}

/**
 * The showcase in the user's language. Each field is taken from the first translation along
 * {@link localeVariantChain} that has it (`es-MX` → `es-MX`, then `es`), otherwise from the Russian
 * base: a language without a translation (`pl`, or `ru` itself) sees the base text. Norms, order and
 * tile gates always come from the base. The result has no `i18n`: it is what the catalog returns.
 *
 * Expects a normalised profile (from {@link normalizeAgentShowcaseProfile} or
 * {@link parseAgentShowcaseExtension}) — its translation keys are already in canonical case.
 */
export function localizeAgentShowcaseProfile(
  profile: AgentShowcaseProfile,
  locale: string | undefined,
): AgentShowcaseProfile {
  const { i18n, ...base } = profile
  const variants = localeVariantChain(locale)
    .map((tag) => i18n?.[tag])
    .filter((variant): variant is AgentShowcaseVariant => variant !== undefined)
  const localized = overlayText(base as AgentShowcaseProfile, variants)
  if (base.capabilities) {
    localized.capabilities = base.capabilities.map((capability) =>
      overlayText(
        capability,
        variants.flatMap((v) => v.capabilities?.filter((c) => c.id === capability.id) ?? []),
      ),
    )
  }
  return localized
}
