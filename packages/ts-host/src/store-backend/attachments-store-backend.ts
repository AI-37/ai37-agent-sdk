import { currentBearer } from '../als'
import type {
  EditResult,
  FileInfo,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadRawResult,
  ReadResult,
  StoreBackend,
  WriteResult,
} from './types'

/** DTO REST вложений chat-backend (см. attachments.types на стороне chat-backend). */
interface AttachmentMetaDto {
  fileId: string
  sourceName: string
  mime: string
  bytes: number
  sha256: string
  summary: string
  isLarge: boolean
  uploadedAt: string
  expiresAt?: string
}
interface AttachmentGrepHitDto {
  fileId: string
  sourceName: string
  line: number
  snippet: string
}

const READ_ONLY = 'Вложения доступны только для чтения (агенты read-only к file:<id>)'

/**
 * База для StoreBackend'ов вложений: тонкий HTTP-клиент к REST chat-backend (как ChatStoreBackend).
 * Сами файлы (Redis/Postgres) знает только chat-backend — единая точка auth/tenancy. Агент работает
 * штатной ФС-эргономикой deepagents `CompositeBackend`; физически операции уходят в chat-backend с JWT.
 *
 * MOUNT-RELATIVE по контракту CompositeBackend: composite срезает префикс маунта на входе и добавляет
 * его к путям результатов на выходе, поэтому бэкенд оперирует путями ОТНОСИТЕЛЬНО точки монтирования
 * и не знает (и не должен знать), куда смонтирован — один инстанс можно монтировать в несколько
 * префиксов. `anchor` — лишь ИМЯ канонического маунта (`/<anchor>/`): используется в текстах ошибок
 * и в markdown-манифесте (текст для LLM, которая видит внешние — смонтированные — пути).
 *
 * Виртуальная ФС (пути относительные):
 * - `/`          — манифест файлов: `ls` (структурно) / `read` (markdown с source_name/summary);
 * - `/{fileId}`  — `read` окна markdown (offset/limit);
 * - `grep` — серверный поиск по содержимому; `glob` — по имени файла; `write/edit` — read-only.
 */
abstract class AttachmentsStoreBackendBase implements StoreBackend {
  protected readonly baseUrl: string
  protected readonly bearer: () => string | undefined
  protected readonly fetchImpl: typeof fetch

  /** Сегмент-якорь пути (`chat-attachments` | `project-attachments`). */
  protected abstract readonly anchor: string
  /** База REST в chat-backend (`/api/chat-attachments` | `/api/project-attachments`). */
  protected abstract readonly apiBase: string
  /** Query для манифест-операций (ls/glob/grep). null → скоуп не резолвится (вернуть ошибку). */
  protected abstract scopeForManifest(): Record<string, string> | null
  /** Query для пофайловых операций (read content). chat → contextId; project → пусто. */
  protected abstract scopeForFile(): Record<string, string> | null

  constructor(opts: { baseUrl: string; bearer?: () => string | undefined; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.bearer = opts.bearer ?? currentBearer
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  // ── ls ─────────────────────────────────────────────────────────────────────
  async ls(path: string): Promise<LsResult> {
    const fileId = this.parse(path)
    if (fileId === null) return { error: `Не директория: ${path}` }
    if (fileId) return { error: `Не директория: ${path}` }
    const scope = this.scopeForManifest()
    if (!scope) return { error: this.scopeMissing() }
    try {
      const { attachments } = await this.api<{ attachments: AttachmentMetaDto[] }>('/', scope)
      return { files: attachments.map((a) => this.fileInfo(a)) }
    } catch (e) {
      return { error: errMsg(e) }
    }
  }

  // ── read (директория → манифест; файл → окно markdown) ────────────────────────
  async read(path: string, offset?: number, limit?: number): Promise<ReadResult> {
    const fileId = this.parse(path)
    if (fileId === null) return { error: `Неизвестный путь: ${path}` }
    try {
      if (!fileId) {
        const scope = this.scopeForManifest()
        if (!scope) return { error: this.scopeMissing() }
        const { attachments } = await this.api<{ attachments: AttachmentMetaDto[] }>('/', scope)
        return { content: renderManifest(this.anchor, attachments), mimeType: 'text/markdown' }
      }
      const scope = this.scopeForFile()
      if (!scope) return { error: this.scopeMissing() }
      const query: Record<string, string> = { ...scope }
      if (offset !== undefined) query.offset = String(offset)
      if (limit !== undefined) query.limit = String(limit)
      const { content } = await this.api<{ content: string }>(`/${enc(fileId)}/content`, query)
      return { content, mimeType: 'text/markdown' }
    } catch (e) {
      return { error: errMsg(e) }
    }
  }

  // ── glob (по имени файла, клиентский фильтр манифеста) ────────────────────────
  // path игнорируем: scope (contextId/projectId) берётся из резолвера хода, не из пути.
  async glob(pattern: string, _path?: string): Promise<GlobResult> {
    const scope = this.scopeForManifest()
    if (!scope) return { error: this.scopeMissing() }
    try {
      const needle = stripGlob(pattern).toLowerCase()
      const { attachments } = await this.api<{ attachments: AttachmentMetaDto[] }>('/', scope)
      const files = attachments
        .filter((a) => !needle || a.sourceName.toLowerCase().includes(needle))
        .map((a) => this.fileInfo(a))
      return { files }
    } catch (e) {
      return { error: errMsg(e) }
    }
  }

  // ── grep (по содержимому, серверный поиск) ────────────────────────────────────
  async grep(pattern: string, _path?: string | null, _glob?: string | null): Promise<GrepResult> {
    const scope = this.scopeForManifest()
    if (!scope) return { error: this.scopeMissing() }
    try {
      const { matches } = await this.api<{ matches: AttachmentGrepHitDto[] }>('/search', {
        ...scope,
        q: pattern,
      })
      return {
        matches: matches.map<GrepMatch>((h) => ({
          // Путь относительный — внешний префикс добавит CompositeBackend.
          path: `/${h.fileId}`,
          line: h.line,
          text: `[${h.sourceName}] ${oneLine(h.snippet)}`,
        })),
      }
    } catch (e) {
      return { error: errMsg(e) }
    }
  }

  // ── read-only ────────────────────────────────────────────────────────────────
  write(): Promise<WriteResult> {
    return Promise.resolve({ error: READ_ONLY })
  }
  edit(): Promise<EditResult> {
    return Promise.resolve({ error: READ_ONLY })
  }
  // Вложения — markdown-ТЕКСТ; raw-бинарь не отдаём (агент читает окнами через `read`).
  readRaw(): Promise<ReadRawResult> {
    return Promise.resolve({ error: 'readRaw не поддерживается: используйте read (markdown-текст)' })
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  /**
   * fileId сегмента (string), '' для корня-директории, null если путь не распознан.
   * Путь относителен точки монтирования (контракт CompositeBackend: префикс срезан до нас):
   * `/` → директория-манифест, `/<fileId>` → файл, глубже одного сегмента — не наш путь.
   * Якорной формы (`/chat-attachments/<id>`) больше нет: бэкенд не знает своего маунта.
   */
  protected parse(path: string): string | null {
    const seg = path.split('/').filter(Boolean)
    if (seg.length === 0) return ''
    if (seg.length === 1) return seg[0]
    return null
  }

  // Путь относительный — внешний префикс добавит CompositeBackend.
  protected fileInfo(a: AttachmentMetaDto): FileInfo {
    return { path: `/${a.fileId}`, is_dir: false, size: a.bytes, modified_at: a.uploadedAt }
  }

  protected scopeMissing(): string {
    return `Не задан scope вложений (${this.anchor}) в текущем ходе`
  }

  protected async api<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${this.apiBase}${path}`)
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    const headers: Record<string, string> = { Accept: 'application/json' }
    const token = this.bearer()
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await this.fetchImpl(url.toString(), { headers })
    if (!res.ok) throw new Error(`chat-backend ${this.apiBase}${path} → HTTP ${res.status}`)
    return res.json() as Promise<T>
  }
}

export interface ChatAttachmentsStoreBackendOptions {
  /** База REST chat-backend (тот же хост, что history-API). */
  baseUrl: string
  /** user-JWT для форварда. По умолчанию `currentBearer` из request-scope. */
  bearer?: () => string | undefined
  /** fetch (по умолчанию глобальный). */
  fetchImpl?: typeof fetch
  /** contextId текущего хода — namespace треда в Redis (в chat-backend: turn-scope). */
  contextId: () => string | undefined
}

/**
 * Эфемерные вложения чата (Redis TTL), монтируется на `/chat-attachments/`. Namespace треда —
 * contextId хода (резолвер из request-scope), tenant/owner chat-backend берёт из JWT.
 *
 * ```ts
 * new CompositeBackend(new StateBackend(), {
 *   "/chat-attachments/": new ChatAttachmentsStoreBackend({ baseUrl, contextId: currentTurnContextId }),
 * })
 * // агент: ls('/chat-attachments/'), read('/chat-attachments/<fileId>', 0, 200),
 * //        grep('лифты','/chat-attachments/')
 * ```
 */
export class ChatAttachmentsStoreBackend extends AttachmentsStoreBackendBase {
  protected readonly anchor = 'chat-attachments'
  protected readonly apiBase = '/api/chat-attachments'
  private readonly contextId: () => string | undefined

  constructor(opts: ChatAttachmentsStoreBackendOptions) {
    super(opts)
    this.contextId = opts.contextId
  }

  protected scopeForManifest(): Record<string, string> | null {
    const contextId = this.contextId()
    return contextId ? { contextId } : null
  }
  // Пофайловые операции тоже в namespace треда → нужен contextId.
  protected scopeForFile(): Record<string, string> | null {
    return this.scopeForManifest()
  }
}

export interface ProjectAttachmentsStoreBackendOptions {
  baseUrl: string
  bearer?: () => string | undefined
  fetchImpl?: typeof fetch
  /** projectId/slug текущего треда (в chat-backend выводится из Thread.projectId). */
  projectId: () => string | undefined
}

/**
 * Durable-вложения проекта (Postgres), монтируется на `/project-attachments/`. Манифест/grep скоупятся
 * по projectId; пофайловые read резолвятся по fileId в скоупе владельца (projectId не нужен).
 *
 * ```ts
 * new CompositeBackend(new StateBackend(), {
 *   "/project-attachments/": new ProjectAttachmentsStoreBackend({ baseUrl, projectId: currentTurnProjectId }),
 * })
 * ```
 */
export class ProjectAttachmentsStoreBackend extends AttachmentsStoreBackendBase {
  protected readonly anchor = 'project-attachments'
  protected readonly apiBase = '/api/project-attachments'
  private readonly projectId: () => string | undefined

  constructor(opts: ProjectAttachmentsStoreBackendOptions) {
    super(opts)
    this.projectId = opts.projectId
  }

  protected scopeForManifest(): Record<string, string> | null {
    const projectId = this.projectId()
    return projectId ? { projectId } : null
  }
  // read по fileId не требует projectId — chat-backend резолвит в скоупе владельца.
  protected scopeForFile(): Record<string, string> | null {
    return {}
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────────
// Манифест — ТЕКСТ для LLM, которая видит внешние (смонтированные) пути; anchor здесь — имя
// канонического маунта `/<anchor>/`, а не знание бэкенда о фактической точке монтирования.
function renderManifest(anchor: string, attachments: AttachmentMetaDto[]): string {
  const lines = [`# Вложения (${anchor})`, '']
  for (const a of attachments) {
    const flags = a.isLarge ? ' _(большой — грепай, не читай целиком)_' : ''
    lines.push(`- **${a.sourceName}** — \`/${anchor}/${a.fileId}\`${flags}`)
    if (a.summary) lines.push(`  - ${a.summary}`)
  }
  if (attachments.length === 0) lines.push('_нет вложений_')
  return lines.join('\n')
}
function enc(s: string): string {
  return encodeURIComponent(s)
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 200)
}
function stripGlob(pattern: string): string {
  return pattern.replace(/[*?]/g, '').trim()
}
