// Content-negotiation вывода (host-only) — ДВЕ НЕЗАВИСИМЫЕ ОСИ (A2A + AG-UI + A2UI), SSOT.
//
//  1. Формат текста — A2A `acceptedOutputModes` (media-типы). Аналог HTTP `Accept` (SHOULD).
//  2. Каталог(и) UI — A2UI-нативно: клиент шлёт `a2uiClientCapabilities.v0.9.supportedCatalogIds`
//     (список URL каталогов, по убыванию предпочтения) в метаданных КАЖДОГО сообщения; агент берёт
//     согласованное ПОДМНОЖЕСТВО (пересечение со своим списком); нет пересечения → UI не шлётся.
//
// Текст НЕ обязателен (AG-UI `content` опционален; A2A не требует текстовый part). Enforcement —
// здесь и в хендлере хоста. MIME-вокабуляр (`OUTPUT_MODE_*`) — agent-facing, живёт в `@ai37/agent-sdk`.
//
// См. docs/ecosystem/v2/10-agui-protocol.md (РЕШЕНИЕ 10), client_capabilities.json (@a2ui/web_core).

import { OUTPUT_MODE_TEXT, TEXT_OUTPUT_MODES, isTextOutputMode } from '@ai37/agent-sdk'

// ── Ось 1: формат текста (media-типы) ──────────────────────────────────────────────────────────

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

// ── Ось 2: каталог(и) UI (A2UI supportedCatalogIds) ─────────────────────────────────────────────

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
 * Согласованное МНОЖЕСТВО каталогов: пересечение (client ∩ agent) в порядке предпочтения клиента.
 * Агент может эмитить несколько каталогов (напр. ai37-надмножество + базовый A2UI для деградации);
 * клиент рендерит то, что заявил в `supportedCatalogIds`. Пустой результат → UI не слать.
 */
export function negotiateCatalogs(
  supportedCatalogIds: readonly string[] | undefined,
  agentCatalogIds: string | readonly string[] | undefined,
): string[] {
  const agentSet = new Set(
    typeof agentCatalogIds === 'string'
      ? [agentCatalogIds]
      : Array.isArray(agentCatalogIds)
        ? agentCatalogIds
        : [],
  )
  if (agentSet.size === 0) return []
  const clientList = Array.isArray(supportedCatalogIds) ? supportedCatalogIds : []
  return clientList.filter((id) => agentSet.has(id))
}

/**
 * Скалярный выбор каталога (обратная совместимость): первый из согласованного множества, либо `null`.
 */
export function negotiateCatalog(
  supportedCatalogIds: readonly string[] | undefined,
  agentCatalogIds: string | readonly string[] | undefined,
): string | null {
  return negotiateCatalogs(supportedCatalogIds, agentCatalogIds)[0] ?? null
}

// ── Сводная негоциация ──────────────────────────────────────────────────────────────────────────

/**
 * Резолвнутая негоциация вывода (две оси):
 * - `text` — формат текста, ЕСЛИ агент его эмитит (текст не обязателен).
 * - `catalogIds` — согласованные каталоги A2UI (порядок предпочтения клиента); пусто → UI не слать.
 * - `catalogId` — первый из `catalogIds` (или `null`); скалярный alias для обратной совместимости.
 */
export interface OutputNegotiation {
  text: string
  catalogIds: string[]
  catalogId: string | null
}

export interface NegotiateOutputArgs {
  /** A2A `acceptedOutputModes` клиента (media-типы текста). */
  acceptedOutputModes?: readonly string[]
  /** Текстовые форматы, которые умеет агент (agent-card `defaultOutputModes`). */
  agentTextModes?: readonly string[]
  /** Каталоги, заявленные клиентом (`a2uiClientCapabilities.supportedCatalogIds`). */
  supportedCatalogIds?: readonly string[]
  /** Каталог(и), которые эмитит агент (один — `CATALOG_ID`, или массив с base для деградации). */
  agentCatalogIds?: string | readonly string[]
}

export function negotiateOutput(args: NegotiateOutputArgs): OutputNegotiation {
  const catalogIds = negotiateCatalogs(args.supportedCatalogIds, args.agentCatalogIds)
  return {
    text: negotiateText(args.acceptedOutputModes, args.agentTextModes ?? TEXT_OUTPUT_MODES),
    catalogIds,
    catalogId: catalogIds[0] ?? null,
  }
}

/**
 * Отсекает A2UI-компоненты, если каталог не согласован (бинарный enforcement-хелпер).
 * Каталог согласован (`catalogIds` непуст) → компоненты как есть; иначе → [].
 */
export function filterA2uiComponents<T>(
  components: readonly T[] | undefined,
  negotiation: OutputNegotiation,
): T[] {
  if (negotiation.catalogIds.length === 0) return []
  return components ? [...components] : []
}

/**
 * Per-component enforcement: оставляет только компоненты, чей каталог в согласованном множестве.
 * Компонент без `catalogId` относится к первичному каталогу (`catalogIds[0]`). Это включает
 * роутинг A (соседние сообщения из разных каталогов) и деградацию на base.
 */
export function filterA2uiByCatalog<T extends { catalogId?: string }>(
  components: readonly T[] | undefined,
  negotiation: OutputNegotiation,
): T[] {
  if (!components || negotiation.catalogIds.length === 0) return []
  const allowed = new Set(negotiation.catalogIds)
  const primary = negotiation.catalogIds[0]
  return components.filter((c) => allowed.has(c.catalogId ?? primary))
}
