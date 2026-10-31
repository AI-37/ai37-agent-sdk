import { ArtifactsStoreBackend } from '../store-backend/artifacts-store-backend'
import {
  ChatAttachmentsStoreBackend,
  ProjectAttachmentsStoreBackend,
} from '../store-backend/attachments-store-backend'
import type { ReadResult, StoreBackend } from '../store-backend/types'
import type { ArtifactScope } from './artifact-scope'
import type { AttachmentFile, AttachmentTurnScope } from './turn-files'

/**
 * Чтение файлов хода по ref, без виртуальной ФС и без LLM-петли. Под капотом те же
 * Chat/ProjectAttachmentsStoreBackend, то есть REST chat-backend с user-JWT: права проверяет он.
 *
 * Читатель отдаёт только файлы из скоупа хода. Ссылку, которой в ходе нет, он не читает, даже если
 * chat-backend отдал бы файл: модель не должна дотягиваться до соседних тредов по угаданному id.
 * Артефакты (`artifactScope`) читаются так же: только те, что были в загруженном списке.
 */

export interface AttachmentReadersOptions {
  /** База REST chat-backend. */
  chatBackendUrl: string
  scope: AttachmentTurnScope
  /**
   * Артефакты треда и проекта из `artifactScope`. Их файлы добавляются к файлам хода: читатели,
   * поиск и `readAttachmentContents` работают с ними наравне с вложениями.
   */
  artifacts?: ArtifactScope
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
  /**
   * Номер строки совпадения. Файлы проекта и артефакты ищет FTS chat-backend: он отдаёт сниппет
   * без номера строки, и тогда здесь 1 — окно такого файла читается с начала.
   */
  line: number
  text: string
}

export interface WindowedRead {
  content: string
  /** Файл прочитан не целиком: бюджет кончился раньше текста или упёрлись в предел окон. */
  truncated: boolean
  error?: string
}

export interface AttachmentReaders {
  /** Скоуп хода; с `artifacts` в `files` добавлены и артефакты (`kind: 'artifact'`). */
  readonly scope: AttachmentTurnScope
  /** Файл хода по ref; undefined — такого файла в ходе нет. */
  file(ref: string): AttachmentFile | undefined
  /** Окно markdown: offset/limit — номера строк (контракт полки). Без них — файл целиком. */
  read(ref: string, window?: { offset?: number; limit?: number }): Promise<ReadResult>
  /** Поиск по содержимому полок хода; совпадения только по файлам хода. */
  grep(query: string): Promise<{ hits: AttachmentGrepHit[]; errors: string[] }>
  /** Файл окнами до бюджета символов: ограничивает и передачу, и то, что уйдёт в модель. */
  readWithinBudget(ref: string, budgetChars: number): Promise<WindowedRead>
}

/** Высота окна при чтении в бюджет. Меньше — больше запросов, больше — крупнее перебор. */
const WINDOW_LINES = 200
/**
 * Страховка от бесконечного цикла, если полка всегда отвечает «есть ещё». Упор в неё — `truncated`:
 * файл прочитан не целиком.
 */
const MAX_WINDOWS = 1000

/** Полка, из которой читается файл: вложения чата и проекта, артефакты треда и проекта. */
type Shelf = 'chat' | 'project' | 'artifact' | 'project-artifact'

export function createAttachmentReaders(opts: AttachmentReadersOptions): AttachmentReaders {
  const scope = withArtifacts(opts.scope, opts.artifacts)
  const byRef = new Map(scope.files.map((file) => [file.ref, file]))
  const common = { baseUrl: opts.chatBackendUrl, bearer: opts.bearer, fetchImpl: opts.fetchImpl }
  const projectId = opts.artifacts?.projectId ?? scope.projectId
  const shelves: Record<Shelf, StoreBackend> = {
    chat: new ChatAttachmentsStoreBackend({ ...common, contextId: () => scope.contextId }),
    project: new ProjectAttachmentsStoreBackend({ ...common, projectId: () => scope.projectId }),
    artifact: new ArtifactsStoreBackend({
      ...common,
      scope: () => ({ contextId: opts.artifacts?.contextId ?? scope.contextId }),
    }),
    'project-artifact': new ArtifactsStoreBackend({
      ...common,
      scope: () => (projectId ? { projectId } : undefined),
    }),
  }

  const read: AttachmentReaders['read'] = async (ref, window) => {
    const file = byRef.get(ref)
    if (!file) return { error: `Файла ${ref} нет среди приложенных к этому ходу` }
    return shelves[shelfOf(file)].read(fileIdPath(file), window?.offset, window?.limit)
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

/** Файлы хода плюс артефакты; ref, уже приложенный к ходу, второй раз не добавляется. */
function withArtifacts(
  scope: AttachmentTurnScope,
  artifacts: ArtifactScope | undefined,
): AttachmentTurnScope {
  if (!artifacts?.files.length) return scope
  const refs = new Set(scope.files.map((file) => file.ref))
  return {
    ...scope,
    files: [...scope.files, ...artifacts.files.filter((file) => !refs.has(file.ref))],
  }
}

function shelfOf(file: AttachmentFile): Shelf {
  if (file.kind !== 'artifact') return file.scope
  return file.scope === 'chat' ? 'artifact' : 'project-artifact'
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

const REF_PREFIX: Record<Shelf, string> = {
  chat: 'chat-attachment:',
  project: 'project-attachment:',
  artifact: 'artifact:',
  'project-artifact': 'project-artifact:',
}

async function grepShelves(
  shelves: Record<Shelf, StoreBackend>,
  scope: AttachmentTurnScope,
  byRef: ReadonlyMap<string, AttachmentFile>,
  query: string,
): Promise<{ hits: AttachmentGrepHit[]; errors: string[] }> {
  // Полка ищет по всему треду или проекту; лишнее отсекаем по списку файлов хода.
  const kinds = [...new Set(scope.files.map(shelfOf))]
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

/**
 * Чтение окнами до бюджета символов. Окна строчные (так режет полка), бюджет символьный: пятьдесят
 * строк бывают и пятью сотнями символов, и полумегабайтной таблицей. Поэтому читаем окна
 * фиксированной высоты и останавливаемся, набрав бюджет; перебор последнего окна обрезаем.
 *
 * Полка (chat-backend `windowLines`) отдаёт `lines.slice(offset, offset + limit).join('\n')`: без
 * номеров строк и без признака конца файла. Пустая строка в конце окна даёт хвостовой `\n`, в начале
 * — ведущий, поэтому ни длина окна, ни его края о конце файла ничего не говорят. Признак конца берём
 * сами: просим на строку больше окна. Пришла лишняя строка — файл продолжается, её отбрасываем и
 * дочитываем следующим окном; не пришла — это последнее окно, и лишнего запроса за пустым хвостом нет.
 */
async function readWindowsWithinBudget(
  readWindow: (offset: number, limit: number) => ReadResult | Promise<ReadResult>,
  budgetChars: number,
): Promise<WindowedRead> {
  if (budgetChars <= 0) return { content: '', truncated: true }
  const parts: string[] = []
  let taken = 0
  for (let window = 0; window < MAX_WINDOWS; window += 1) {
    const result = await readWindow(window * WINDOW_LINES, WINDOW_LINES + 1)
    if (result.error) return { content: '', truncated: false, error: result.error }
    const { text, more } = windowText(typeof result.content === 'string' ? result.content : '')
    // Окна — куски одного split('\n'), поэтому склейка всегда через \n, даже вокруг пустых строк.
    const addition = window === 0 ? text : `\n${text}`
    if (taken + addition.length > budgetChars) {
      parts.push(addition.slice(0, budgetChars - taken))
      return { content: parts.join(''), truncated: true }
    }
    parts.push(addition)
    taken += addition.length
    if (!more) return { content: parts.join(''), truncated: false }
  }
  // Упёрлись в страховку, а файл ещё не кончился: прочитан не целиком.
  return { content: parts.join(''), truncated: true }
}

/** Окно, запрошенное со строкой-разведчиком: текст без неё и признак, что файл продолжается. */
function windowText(chunk: string): { text: string; more: boolean } {
  const lines = chunk.split('\n')
  if (lines.length <= WINDOW_LINES) return { text: chunk, more: false }
  return { text: lines.slice(0, WINDOW_LINES).join('\n'), more: true }
}
