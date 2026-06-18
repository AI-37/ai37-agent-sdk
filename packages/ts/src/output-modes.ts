// Протокольный ВОКАБУЛЯР формата текста (media-типы) — agent-facing SSOT.
//
// Этим словарём агент декларирует `defaultOutputModes` в agent-card. Сама content-negotiation
// (выбор формата/каталога) и enforcement — в хосте (`@ai37/agent-host`, src/output-modes.ts),
// т.к. это его зона ответственности; сюда вынесены только разделяемые константы media-типов.
//
// См. docs/ecosystem/v2/10-agui-protocol.md (РЕШЕНИЕ 10), client_capabilities.json (@a2ui/web_core).

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
