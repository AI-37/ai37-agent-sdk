import { contextFilePath } from '../store-backend/file-context'
import type { ContextFile } from '../types'

/**
 * Файлы, которые агент может прочитать в текущем ходе. Список собирается детерминированно из
 * `context_refs` и манифеста `context_files` хода: LLM в выборе путей не участвует.
 *
 * Раньше каждый агент держал копию этой логики (thermal, elevator, doc-gen, шаблон), и копии
 * разошлись. Здесь она одна.
 */

const CHAT_PREFIX = 'chat-attachment:'
const PROJECT_FILE_PREFIX = 'project-attachment:'
const PROJECT_PREFIX = 'project:'

/** Один файл хода: адрес для чтения плюс то, что о нём известно из манифеста. */
export interface AttachmentFile {
  /** `chat-attachment:<id>` | `project-attachment:<id>`. */
  ref: string
  /** Путь виртуальной ФС (`/chat-attachments/<id>`), см. `contextFilePath`. */
  path: string
  /** Имя из манифеста; если манифест не пришёл — сам ref. */
  name: string
  summary?: string
  scope: 'chat' | 'project'
  isLarge?: boolean
}

/** Всё, что нужно для чтения файлов хода: namespace треда, проект и список файлов. */
export interface AttachmentTurnScope {
  contextId: string
  /** Из `project:<id>` в context_refs: нужен манифесту и поиску по полке проекта. */
  projectId?: string
  files: AttachmentFile[]
}

export interface AttachmentTurnInput {
  contextId: string
  contextRefs?: readonly string[]
  contextFiles?: readonly ContextFile[]
}

/** Есть ли в `context_refs` ссылки, по которым имеет смысл идти за файлами. */
export function hasFileRefs(refs: readonly string[]): boolean {
  return refs.some(
    (ref) =>
      ref.startsWith(CHAT_PREFIX) ||
      ref.startsWith(PROJECT_FILE_PREFIX) ||
      ref.startsWith(PROJECT_PREFIX),
  )
}

/** projectId из `project:<id>`; undefined, если ход не в проекте. */
export function projectIdFromRefs(refs: readonly string[]): string | undefined {
  const ref = refs.find((r) => r.startsWith(PROJECT_PREFIX))
  return ref?.slice(PROJECT_PREFIX.length) || undefined
}

/**
 * Скоуп файлов хода. Ссылки берутся и из `context_refs`, и из манифеста: манифест может не дойти
 * от старого оркестратора, а `context_refs` не несут имён. Дубли по ref схлопываются, ссылки
 * не-файлового вида (`project:<id>`) в список файлов не попадают.
 */
export function attachmentScope(input: AttachmentTurnInput): AttachmentTurnScope {
  const refs = input.contextRefs ?? []
  const manifest = input.contextFiles ?? []
  const meta = new Map(manifest.map((file) => [file.ref, file]))
  const files = new Map<string, AttachmentFile>()

  for (const ref of [...refs, ...manifest.map((file) => file.ref)]) {
    if (files.has(ref)) continue
    const file = toAttachmentFile(ref, meta.get(ref))
    if (file) files.set(ref, file)
  }

  return {
    contextId: input.contextId,
    projectId: projectIdFromRefs(refs),
    files: [...files.values()],
  }
}

function toAttachmentFile(ref: string, meta: ContextFile | undefined): AttachmentFile | null {
  const scope = shelfOf(ref)
  const path = scope ? contextFilePath(ref) : null
  if (!scope || !path) return null
  const file: AttachmentFile = { ref, path, name: meta?.name || ref, scope }
  if (meta?.summary) file.summary = meta.summary
  if (meta?.isLarge) file.isLarge = true
  return file
}

function shelfOf(ref: string): AttachmentFile['scope'] | null {
  if (ref.startsWith(CHAT_PREFIX)) return 'chat'
  if (ref.startsWith(PROJECT_FILE_PREFIX)) return 'project'
  return null
}
