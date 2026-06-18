// Канон content-negotiation вывода — ДВЕ НЕЗАВИСИМЫЕ ОСИ (A2A + AG-UI + A2UI), SSOT.
//
//  1. Формат текста — A2A `acceptedOutputModes` (media-типы). Аналог HTTP `Accept` (SHOULD).
//  2. Каталог UI — A2UI-нативно: клиент шлёт `a2uiClientCapabilities.v0.9.supportedCatalogIds`
//     (список URL каталогов, по убыванию предпочтения) в метаданных КАЖДОГО сообщения; агент
//     берёт лучший матч; нет матча → UI не шлётся.
//
// Текст НЕ обязателен (AG-UI `content` опционален; A2A не требует текстовый part). Агент эмитит
// ОДНО представление: каталог поддержан → компонент (XOR короткий не-дублирующий лид-ин), иначе →
// текст-fallback. Enforcement — в хосте (`@ai37/agent-host`).
//
// См. docs/ecosystem/v2/10-agui-protocol.md (РЕШЕНИЕ 10), client_capabilities.json (@a2ui/web_core).

// ── Ось 1: формат текста (media-типы) ──────────────────────────────────────────────────────────

/** Простой текст. */
export const OUTPUT_MODE_TEXT = 'text/plain'
/** Markdown. */
export const OUTPUT_MODE_MARKDOWN = 'text/markdown'
/** Markdown под рендерер SP-AI. */
export const OUTPUT_MODE_MARKDOWN_SPAI = 'text/vnd.markdown+spai-renderer'

/** Текстовые modes по убыванию «богатства». */
export const TEXT_OUTPUT_MODES = [
  OUTPUT_MODE_MARKDOWN_SPAI,
  OUTPUT_MODE_MARKDOWN,
  OUTPUT_MODE_TEXT,
] as const

const TEXT_MODE_SET = new Set<string>(TEXT_OUTPUT_MODES)
/** Является ли mode текстовым media-типом. */
export const isTextOutputMode = (mode: string): boolean => TEXT_MODE_SET.has(mode)

/**
 * Выбор текстового формата: первый текстовый mode из пересечения (client ∩ agentSupported) по
 * порядку клиента; если пересечения нет — `text/plain`. Текст всегда имеет валидный формат — но это
 * НЕ значит, что текст обязан эмититься (это решает агент, отдавая `message` или нет).
 */
export function negotiateText(
  accepted: readonly string[] | undefined,
  agentSupported: readonly string[],
): string {
  const supported = new Set(agentSupported)
  const list = Array.isArray(accepted) ? accepted : []
  return list.find((m) => isTextOutputMode(m) && supported.has(m)) ?? OUTPUT_MODE_TEXT
}

// ── Ось 2: каталог UI (A2UI supportedCatalogIds) ────────────────────────────────────────────────

/** Версия A2UI-протокола в конверте capabilities. */
export const A2UI_CAPABILITIES_VERSION = 'v0.9'

/** Форма `a2uiClientCapabilities` (A2A message metadata / AG-UI forwardedProps). */
export interface A2uiClientCapabilities {
  [version: string]: { supportedCatalogIds?: string[] } | undefined
}

/**
 * Достаёт `supportedCatalogIds` из объекта-носителя (A2A `message.metadata` или AG-UI
 * `forwardedProps`), который может содержать `a2uiClientCapabilities.v0.9.supportedCatalogIds`.
 * Возвращает упорядоченный список URL каталогов (или []).
 */
export function readClientCapabilities(source: unknown): string[] {
  const caps = (source as { a2uiClientCapabilities?: A2uiClientCapabilities } | undefined)
    ?.a2uiClientCapabilities
  const ids = caps?.[A2UI_CAPABILITIES_VERSION]?.supportedCatalogIds
  return Array.isArray(ids) ? ids.filter((s): s is string => typeof s === 'string') : []
}

/** Поддерживает ли клиент данный каталог. */
export function clientSupportsCatalog(
  supportedCatalogIds: readonly string[] | undefined,
  agentCatalogId: string | undefined,
): boolean {
  return (
    !!agentCatalogId &&
    Array.isArray(supportedCatalogIds) &&
    supportedCatalogIds.includes(agentCatalogId)
  )
}

/**
 * Выбор каталога: возвращает `agentCatalogId`, если он есть в списке клиента (нет матча → null →
 * UI не шлётся). Агент эмитит один каталог (`agentCatalogId`); расширяемо до нескольких — тогда
 * берётся первый из клиентского списка, который агент поддерживает (по порядку клиента).
 */
export function negotiateCatalog(
  supportedCatalogIds: readonly string[] | undefined,
  agentCatalogIds: string | readonly string[] | undefined,
): string | null {
  const agentSet = new Set(
    typeof agentCatalogIds === 'string'
      ? [agentCatalogIds]
      : Array.isArray(agentCatalogIds)
        ? agentCatalogIds
        : [],
  )
  if (agentSet.size === 0) return null
  const clientList = Array.isArray(supportedCatalogIds) ? supportedCatalogIds : []
  return clientList.find((id) => agentSet.has(id)) ?? null
}

// ── Сводная негоциация ──────────────────────────────────────────────────────────────────────────

/**
 * Резолвнутая негоциация вывода (две оси):
 * - `text` — формат текста, ЕСЛИ агент его эмитит (текст не обязателен).
 * - `catalogId` — выбранный каталог A2UI, либо `null` (UI не слать).
 */
export interface OutputNegotiation {
  text: string
  catalogId: string | null
}

export interface NegotiateOutputArgs {
  /** A2A `acceptedOutputModes` клиента (media-типы текста). */
  acceptedOutputModes?: readonly string[]
  /** Текстовые форматы, которые умеет агент (agent-card `defaultOutputModes`). */
  agentTextModes?: readonly string[]
  /** Каталоги, заявленные клиентом (`a2uiClientCapabilities.supportedCatalogIds`). */
  supportedCatalogIds?: readonly string[]
  /** Каталог(и), которые эмитит агент (обычно один — `CATALOG_ID`). */
  agentCatalogIds?: string | readonly string[]
}

export function negotiateOutput(args: NegotiateOutputArgs): OutputNegotiation {
  return {
    text: negotiateText(args.acceptedOutputModes, args.agentTextModes ?? TEXT_OUTPUT_MODES),
    catalogId: negotiateCatalog(args.supportedCatalogIds, args.agentCatalogIds),
  }
}

/**
 * Отсекает A2UI-компоненты, если каталог не согласован (enforcement-хелпер для хоста/хендлера).
 * Бинарно: каталог согласован (`catalogId`) → компоненты как есть; иначе → [].
 */
export function filterA2uiComponents<T>(
  components: readonly T[] | undefined,
  negotiation: OutputNegotiation,
): T[] {
  if (!negotiation.catalogId) return []
  return components ? [...components] : []
}
