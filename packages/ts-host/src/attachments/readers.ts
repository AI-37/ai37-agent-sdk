import {
  ChatAttachmentsStoreBackend,
  ProjectAttachmentsStoreBackend,
} from '../store-backend/attachments-store-backend'
import type { ReadResult, StoreBackend } from '../store-backend/types'
import type { AttachmentFile, AttachmentTurnScope } from './turn-files'

/**
 * Чтение файлов хода по ref, без виртуальной ФС и без LLM-петли. Под капотом те же
 * Chat/ProjectAttachmentsStoreBackend, то есть REST chat-backend с user-JWT: права проверяет он.
 *
 * Читатель отдаёт только файлы из скоупа хода. Ссылку, которой в ходе нет, он не читает, даже если
 * chat-backend отдал бы файл: модель не должна дотягиваться до соседних тредов по угаданному id.
 */

export interface AttachmentReadersOptions {
  /** База REST chat-backend. */
  chatBackendUrl: string
  scope: AttachmentTurnScope
  /**
   * user-JWT для chat-backend. По умолчанию `currentBearer` из request-scope хоста. Код, который
   * работает вне него (HTTP-мост DSH, фоновая задача), передаёт токен явно.
   */
  bearer?: () => string | undefined
  fetchImpl?: typeof fetch
}

export interface AttachmentGrepHit {
  ref: string
  name: string
  line: number
  text: string
}

export interface WindowedRead {
  content: string
  /** Файл прочитан не целиком: бюджет кончился раньше текста. */
  truncated: boolean
  error?: string
}

export interface AttachmentReaders {
  readonly scope: AttachmentTurnScope
  /** Файл хода по ref; undefined — такого файла в ходе нет. */
  file(ref: string): AttachmentFile | undefined
  /** Окно markdown: offset/limit — номера строк (контракт полки). Без них — файл целиком. */
  read(ref: string, window?: { offset?: number; limit?: number }): Promise<ReadResult>
  /** Поиск по содержимому обеих полок; совпадения только по файлам хода. */
  grep(query: string): Promise<{ hits: AttachmentGrepHit[]; errors: string[] }>
  /** Файл окнами до бюджета символов: ограничивает и передачу, и то, что уйдёт в модель. */
  readWithinBudget(ref: string, budgetChars: number): Promise<WindowedRead>
}

/** Высота окна при чтении в бюджет. Меньше — больше запросов, больше — крупнее перебор. */
const WINDOW_LINES = 200
/** Страховка от бесконечного цикла, если полка перестанет сдвигать offset. */
const MAX_WINDOWS = 1000

export function createAttachmentReaders(opts: AttachmentReadersOptions): AttachmentReaders {
  const { scope } = opts
  const byRef = new Map(scope.files.map((file) => [file.ref, file]))
  const common = { baseUrl: opts.chatBackendUrl, bearer: opts.bearer, fetchImpl: opts.fetchImpl }
  const shelves: Record<AttachmentFile['scope'], StoreBackend> = {
    chat: new ChatAttachmentsStoreBackend({ ...common, contextId: () => scope.contextId }),
    project: new ProjectAttachmentsStoreBackend({ ...common, projectId: () => scope.projectId }),
  }

  const read: AttachmentReaders['read'] = async (ref, window) => {
    const file = byRef.get(ref)
    if (!file) return { error: `Файла ${ref} нет среди приложенных к этому ходу` }
    return shelves[file.scope].read(fileIdPath(file), window?.offset, window?.limit)
  }

  return {
    scope,
    file: (ref) => byRef.get(ref),
    read,
    grep: (query) => grepShelves(shelves, scope, byRef, query),
    readWithinBudget: (ref, budgetChars) =>
      readWindowsWithinBudget((offset, limit) => read(ref, { offset, limit }), budgetChars),
  }
}

/**
 * Причина отказа чтения по тексту ошибки бэкенда (`chat-backend … → HTTP 403`). 404 значит, что
 * полка не отдала тело; почему — из кода не следует (истёк TTL, не тот namespace), поэтому
 * «недоступен», а не «удалён».
 */
export function attachmentFailureReason(
  error: unknown,
): 'access_denied' | 'unavailable' | 'reader_failed' {
  const text = error instanceof Error ? error.message : String(error)
  if (/\b(?:401|403)\b/.test(text)) return 'access_denied'
  if (/\b(?:404|410)\b/.test(text)) return 'unavailable'
  return 'reader_failed'
}

/** Путь файла относительно точки монтирования полки: бэкенды mount-relative. */
function fileIdPath(file: AttachmentFile): string {
  const segments = file.path.split('/').filter(Boolean)
  return `/${segments[segments.length - 1] ?? ''}`
}

const REF_PREFIX: Record<AttachmentFile['scope'], string> = {
  chat: 'chat-attachment:',
  project: 'project-attachment:',
}

async function grepShelves(
  shelves: Record<AttachmentFile['scope'], StoreBackend>,
  scope: AttachmentTurnScope,
  byRef: ReadonlyMap<string, AttachmentFile>,
  query: string,
): Promise<{ hits: AttachmentGrepHit[]; errors: string[] }> {
  // Полка ищет по всему треду или проекту; лишнее отсекаем по списку файлов хода.
  const kinds = [...new Set(scope.files.map((file) => file.scope))]
  const results = await Promise.all(
    kinds.map(async (kind) => ({ kind, res: await shelves[kind].grep(query) })),
  )
  const hits: AttachmentGrepHit[] = []
  const errors: string[] = []
  for (const { kind, res } of results) {
    if (res.error) errors.push(res.error)
    for (const match of res.matches ?? []) {
      const file = byRef.get(`${REF_PREFIX[kind]}${match.path.replace(/^\/+/, '')}`)
      if (file)
        hits.push({
          ref: file.ref,
          name: file.name,
          line: match.line,
          text: stripSourceName(match.text),
        })
    }
  }
  return { hits, errors }
}

/** Бэкенд кладёт имя файла в начало строки совпадения (`[имя] …`); имя у нас уже есть отдельно. */
function stripSourceName(text: string): string {
  return text.replace(/^\[[^\]]*\]\s*/, '')
}

/**
 * Чтение окнами до бюджета символов. Окна строчные (так режет полка), бюджет символьный: пятьдесят
 * строк бывают и пятью сотнями символов, и полумегабайтной таблицей. Поэтому читаем окна
 * фиксированной высоты и останавливаемся, набрав бюджет; перебор последнего окна обрезаем.
 */
/**
 * То же чтение окнами в бюджет, но по готовому StoreBackend и пути, без скоупа хода. Для файлов,
 * которые агент нашёл сам и к ходу они не приложены (поиск по корпусу проекта): права проверяет
 * chat-backend, а читатели хода по-прежнему отдают только файлы хода.
 */
export function readStoreWithinBudget(
  backend: Pick<StoreBackend, 'read'>,
  path: string,
  budgetChars: number,
): Promise<WindowedRead> {
  return readWindowsWithinBudget((offset, limit) => backend.read(path, offset, limit), budgetChars)
}

async function readWindowsWithinBudget(
  readWindow: (offset: number, limit: number) => ReadResult | Promise<ReadResult>,
  budgetChars: number,
): Promise<WindowedRead> {
  if (budgetChars <= 0) return { content: '', truncated: true }
  const parts: string[] = []
  let taken = 0
  let offset = 0
  for (let window = 0; window < MAX_WINDOWS; window += 1) {
    const result = await readWindow(offset, WINDOW_LINES)
    if (result.error) return { content: '', truncated: false, error: result.error }
    const chunk = typeof result.content === 'string' ? result.content : ''
    if (!chunk) break
    const addition = joinWindow(parts, chunk)
    if (taken + addition.length >= budgetChars) {
      parts.push(addition.slice(0, budgetChars - taken))
      return { content: parts.join(''), truncated: true }
    }
    parts.push(addition)
    taken += addition.length
    const lines = countLines(chunk)
    if (lines < WINDOW_LINES) break
    offset += lines
  }
  return { content: parts.join(''), truncated: false }
}

/** Полка склеивает строки окна через \n без хвостового перевода: встык граничные строки срослись бы. */
function joinWindow(parts: readonly string[], chunk: string): string {
  const last = parts[parts.length - 1]
  const needsSeparator = last !== undefined && !last.endsWith('\n') && !chunk.startsWith('\n')
  return needsSeparator ? `\n${chunk}` : chunk
}

function countLines(chunk: string): number {
  const trimmed = chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk
  return trimmed.length === 0 ? 0 : trimmed.split('\n').length
}
