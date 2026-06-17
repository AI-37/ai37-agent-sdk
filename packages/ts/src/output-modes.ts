// Канон content-negotiation вывода (output modes) — единый источник истины (SSOT).
//
// Формат ответа выбирает КЛИЕНТ через список MIME-типов `acceptedOutputModes`
// (нативное поле A2A `MessageSendConfiguration.acceptedOutputModes`, прямой аналог HTTP `Accept`).
// Дефолт — текст: если A2UI-тип не запрошен явно, агент компоненты НЕ присылает.
// Enforcement живёт в хосте (`@ai37/agent-host`); здесь — только чистая логика негоциации.
//
// См. docs/ecosystem/v2/10-agui-protocol.md (РЕШЕНИЕ 10) и docs/a2ui-negotiation-plan.md.

// Лёгкий subpath — только строковые id каталогов, без zod-схем из барреля.
import { CATALOG_ID, A2UI_BASE_CATALOG_ID } from '@ai37/a2ui-catalog-schemas/constants'

/** Простой текст. */
export const OUTPUT_MODE_TEXT = 'text/plain'
/** Markdown. */
export const OUTPUT_MODE_MARKDOWN = 'text/markdown'
/** Markdown под рендерер SP-AI. */
export const OUTPUT_MODE_MARKDOWN_SPAI = 'text/vnd.markdown+spai-renderer'
/** A2UI, базовый каталог (`@a2ui` basicCatalog). */
export const OUTPUT_MODE_A2UI_BASE = 'application/vnd.a2ui+json'
/** A2UI, ai37-каталог (`ai37-a2ui-catalog`, `CATALOG_ID`). */
export const OUTPUT_MODE_A2UI_AI37 = 'application/vnd.a2ui.ai37+json'

/**
 * Текстовые modes по убыванию «богатства» — порядок для дефолтного выбора кодировки,
 * когда клиент не выразил предпочтения среди текстовых.
 */
export const TEXT_OUTPUT_MODES = [
  OUTPUT_MODE_MARKDOWN_SPAI,
  OUTPUT_MODE_MARKDOWN,
  OUTPUT_MODE_TEXT,
] as const

/** A2UI-MIME → catalogId. Каталог кодируется отдельным MIME-типом, не отдельным полем. */
export const A2UI_MODE_CATALOG: Readonly<Record<string, string>> = {
  [OUTPUT_MODE_A2UI_BASE]: A2UI_BASE_CATALOG_ID,
  [OUTPUT_MODE_A2UI_AI37]: CATALOG_ID,
}

const TEXT_MODE_SET = new Set<string>(TEXT_OUTPUT_MODES)
const A2UI_MODE_SET = new Set<string>([OUTPUT_MODE_A2UI_BASE, OUTPUT_MODE_A2UI_AI37])

/** Является ли mode текстовым. */
export const isTextOutputMode = (mode: string): boolean => TEXT_MODE_SET.has(mode)
/** Является ли mode A2UI-каталогом. */
export const isA2uiOutputMode = (mode: string): boolean => A2UI_MODE_SET.has(mode)

/** Запросил ли клиент хоть один A2UI-mime. */
export function clientAcceptsA2ui(accepted: readonly string[] | undefined): boolean {
  return Array.isArray(accepted) && accepted.some(isA2uiOutputMode)
}

/**
 * Результат негоциации формата вывода.
 * - `text` — текстовый mode, в котором эмитить текст. Текст эмитится ВСЕГДА (это не фолбэк на
 *   компоненты, а выбор кодировки текста: текст обязан присутствовать в любом ответе).
 * - `a2ui` — `false`, если A2UI не запрошен/не поддержан (дефолт). Иначе `{ catalogId, mode }`.
 */
export interface OutputNegotiation {
  text: string
  a2ui: false | { catalogId: string; mode: string }
}

/**
 * Строгая негоциация (дефолт — текст).
 *
 * @param accepted        упорядоченный список предпочтений клиента (A2A-семантика `acceptedOutputModes`).
 * @param agentSupported  что агент реально умеет отдавать (agent-card `defaultOutputModes`/`outputModes`).
 *
 * Правила:
 * - **Текст всегда есть.** `text` = первый текстовый mode из пересечения (client ∩ agentSupported)
 *   по порядку клиента; если пересечения нет — `text/plain`.
 * - **A2UI только по явному запросу.** `a2ui` ≠ false только если клиент перечислил A2UI-mime
 *   И агент его поддерживает. Каталог берётся из mime; `ai37` предпочтительнее `base`, если клиент
 *   принял оба. Нет A2UI-mime у клиента → `a2ui: false`.
 */
export function negotiateOutput(
  accepted: readonly string[] | undefined,
  agentSupported: readonly string[],
): OutputNegotiation {
  const supported = new Set(agentSupported)
  const acceptedList = Array.isArray(accepted) ? accepted : []

  // --- текст: первый текстовый mode из пересечения по порядку клиента, иначе text/plain ---
  const text =
    acceptedList.find((m) => isTextOutputMode(m) && supported.has(m)) ?? OUTPUT_MODE_TEXT

  // --- A2UI: только при явном запросе клиента и поддержке агентом; ai37 предпочтительнее base ---
  const a2uiAccepted = acceptedList.filter((m) => isA2uiOutputMode(m) && supported.has(m))
  let a2ui: OutputNegotiation['a2ui'] = false
  if (a2uiAccepted.length > 0) {
    const mode = a2uiAccepted.includes(OUTPUT_MODE_A2UI_AI37)
      ? OUTPUT_MODE_A2UI_AI37
      : a2uiAccepted[0]
    a2ui = { catalogId: A2UI_MODE_CATALOG[mode], mode }
  }

  return { text, a2ui }
}

/**
 * Отсекает A2UI-компоненты, если они не были запрошены (enforcement-хелпер для хоста/хендлера).
 * Компоненты не помечены каталогом по-отдельности — каталог задаётся на уровне поверхности
 * через `negotiation.a2ui.catalogId`, поэтому фильтр бинарный: запрошен A2UI или нет.
 */
export function filterA2uiComponents<T>(
  components: readonly T[] | undefined,
  negotiation: OutputNegotiation,
): T[] {
  if (!negotiation.a2ui) return []
  return components ? [...components] : []
}
