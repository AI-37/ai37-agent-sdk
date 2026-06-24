import type { ContextFile } from '../types'

/**
 * Переиспользуемый file-aware примитив для агентов. Даёт generic-слой доступа к приложенным файлам поверх
 * `metadata.ai37.context_files`: рендер манифеста (имена/summary) для системного промпта + маппинг
 * `ref` → путь виртуальной ФС StoreBackend (`read`/`grep` по нему). Идея: домен-агент инжектит манифест
 * в промпт своего LLM (тот СРАЗУ видит имена, без manifest-round-trip к store), LLM решает по имени, надо
 * ли читать, и зовёт `read` по пути файла. Доменную часть (ЧТО извлекать) держит сам агент — здесь только
 * файловый доступ, без привязки к домену.
 */

/** Префикс ref → якорь виртуальной ФС StoreBackend (см. attachments-store-backend `anchor`). */
const REF_ANCHORS: ReadonlyArray<readonly [string, string]> = [
  ['project-attachment:', 'project-attachments'],
  ['chat-attachment:', 'chat-attachments'],
]

/**
 * Путь виртуальной ФС для `read`/`grep` по ref'у файла: `project-attachment:<id>` → `/project-attachments/<id>`,
 * `chat-attachment:<id>` → `/chat-attachments/<id>`. null — если ref неизвестного вида (не файл).
 */
export function contextFilePath(ref: string): string | null {
  for (const [prefix, anchor] of REF_ANCHORS) {
    if (ref.startsWith(prefix)) return `/${anchor}/${ref.slice(prefix.length)}`
  }
  return null
}

/**
 * Рендер манифеста `context_files` в компактный markdown-блок для системного промпта агента: имя файла,
 * путь для `read`, флаг «большой», краткое summary. Пустой список → '' (блок не добавляем — поведение
 * как без файлов). Тела файлов сюда НЕ попадают — только метаданные; тело тянет сам агент тулом `read`.
 */
export function renderContextFilesManifest(files: ContextFile[] | undefined): string {
  if (!files || files.length === 0) return ''
  const lines = ['## Приложенные к диалогу файлы', '']
  for (const f of files) {
    const path = contextFilePath(f.ref)
    const loc = path ? `\`${path}\`` : `\`${f.ref}\``
    const large = f.isLarge ? ' _(большой — грепай/read окнами, не целиком)_' : ''
    const summary = f.summary?.trim() ? ` — ${f.summary.trim()}` : ''
    lines.push(`- **${f.name}** — ${loc}${large}${summary}`)
  }
  return lines.join('\n')
}
