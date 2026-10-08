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

/** DTO `/api/artifacts` chat-backend (см. artifacts.types на стороне chat-backend). */
interface ArtifactFileDto {
  id: string
  fileName: string
  mime: string
  bytes: number
  sha256: string
}
interface ArtifactMetaDto {
  id: string
  kind: string
  name: string
  summary: string
  isLarge: boolean
  createdAt: string
  files: ArtifactFileDto[]
}
interface ArtifactSearchHitDto {
  id: string
  kind: string
  name: string
  snippet: string
}

/** Бинарный файл артефакта (DOCX, ZIP, исходная таблица). */
export interface ArtifactFileBody {
  data: Uint8Array
  mime: string
  fileName: string
}

const READ_ONLY =
  'Артефакты неизменяемы: агенты читают их, но не пишут (публикация — publishArtifact)'

export interface ArtifactsStoreBackendOptions {
  /** База REST chat-backend (тот же хост, что у вложений). */
  baseUrl: string
  /**
   * Корпус манифеста и поиска: свои артефакты чата этого диалога (`contextId`) или артефакты
   * проекта (`projectId`). Резолвер зовётся на каждую операцию — значение берётся из текущего хода.
   */
  scope: () => { contextId: string } | { projectId: string } | undefined
  /** user-JWT для форварда. По умолчанию `currentBearer` из request-scope. */
  bearer?: () => string | undefined
  fetchImpl?: typeof fetch
}

/**
 * Read-only StoreBackend выходной полки — артефактов агентов (план files-and-artifacts-layer §3.3).
 * Тонкий HTTP-клиент к `/api/artifacts` chat-backend с форвардом user-JWT, по образцу
 * `ProjectAttachmentsStoreBackend`. Доступ решает chat-backend: чужой артефакт — 404.
 *
 * Инвариант ADR 13: артефакты не приходят в `context_files`; агент видит их, только если ему дали
 * явный ref (`artifact:<id>` / `project-artifact:<id>`) или смонтировали корпус проекта.
 *
 * Виртуальная ФС (пути относительно точки монтирования, как у вложений):
 * - `/`      — манифест артефактов корпуса (`ls` структурно, `read` — markdown с kind/summary);
 * - `/{id}`  — `read` окна markdown артефакта (offset/limit; корпус не нужен — адрес по id);
 * - `grep`   — FTS chat-backend по markdown корпуса; `glob` — по имени;
 * - `write/edit` — ошибка (артефакты неизменяемы). Бинарные файлы — `readFile(id, fileId)`.
 *
 * ```ts
 * new CompositeBackend(new StateBackend(), {
 *   '/artifacts/': new ArtifactsStoreBackend({ baseUrl, scope: () => ({ contextId }) }),
 *   '/project-artifacts/': new ArtifactsStoreBackend({ baseUrl, scope: () => projectId ? { projectId } : undefined }),
 * })
 * ```
 */
export class ArtifactsStoreBackend implements StoreBackend {
  private readonly baseUrl: string
  private readonly scope: ArtifactsStoreBackendOptions['scope']
  private readonly bearer: () => string | undefined
  private readonly fetchImpl: typeof fetch

  constructor(opts: ArtifactsStoreBackendOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.scope = opts.scope
    this.bearer = opts.bearer ?? currentBearer
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  async ls(path: string): Promise<LsResult> {
    if (parse(path) !== '') return { error: `Не директория: ${path}` }
    const list = await this.manifest()
    return 'error' in list ? list : { files: list.artifacts.map(fileInfo) }
  }

  async read(path: string, offset?: number, limit?: number): Promise<ReadResult> {
    const id = parse(path)
    if (id === null) return { error: `Неизвестный путь: ${path}` }
    if (id === '') {
      const list = await this.manifest()
      if ('error' in list) return list
      return { content: renderManifest(list.artifacts), mimeType: 'text/markdown' }
    }
    const query: Record<string, string> = {}
    if (offset !== undefined) query.offset = String(offset)
    if (limit !== undefined) query.limit = String(limit)
    try {
      const { content } = await this.json<{ content: string }>(`/${enc(id)}/content`, query)
      return { content, mimeType: 'text/markdown' }
    } catch (e) {
      return { error: errMsg(e) }
    }
  }

  // path игнорируем: корпус берётся из резолвера хода, не из пути.
  async glob(pattern: string, _path?: string): Promise<GlobResult> {
    const list = await this.manifest()
    if ('error' in list) return list
    const needle = pattern.replace(/[*?]/g, '').trim().toLowerCase()
    return {
      files: list.artifacts
        .filter((a) => !needle || a.name.toLowerCase().includes(needle))
        .map(fileInfo),
    }
  }

  async grep(pattern: string, _path?: string | null, _glob?: string | null): Promise<GrepResult> {
    const scope = this.scope()
    if (!scope) return { error: SCOPE_MISSING }
    try {
      const { matches } = await this.json<{ matches: ArtifactSearchHitDto[] }>('/search', {
        ...scope,
        q: pattern,
      })
      return {
        // FTS не знает номера строки — как у файлов проекта, line = 1.
        matches: matches.map<GrepMatch>((h) => ({
          path: `/${h.id}`,
          line: 1,
          text: `[${h.name}] ${oneLine(h.snippet)}`,
        })),
      }
    } catch (e) {
      return { error: errMsg(e) }
    }
  }

  write(): Promise<WriteResult> {
    return Promise.resolve({ error: READ_ONLY })
  }
  edit(): Promise<EditResult> {
    return Promise.resolve({ error: READ_ONLY })
  }
  // Текст артефакта читается окнами через `read`; бинарные файлы — `readFile`.
  readRaw(): Promise<ReadRawResult> {
    return Promise.resolve({
      error: 'readRaw не поддерживается: текст — read, бинарные файлы — readFile(id, fileId)',
    })
  }

  /** Метаданные артефакта (имя, kind, файлы) по id. */
  async meta(id: string): Promise<ArtifactMetaDto | { error: string }> {
    try {
      const { artifact } = await this.json<{ artifact: ArtifactMetaDto }>(`/${enc(id)}`)
      return artifact
    } catch (e) {
      return { error: errMsg(e) }
    }
  }

  /** Бинарный файл артефакта — байты как есть (для детерминированного разбора, не для LLM). */
  async readFile(id: string, fileId: string): Promise<ArtifactFileBody | { error: string }> {
    try {
      const res = await this.request(`/${enc(id)}/files/${enc(fileId)}`, undefined, '*/*')
      const disposition = res.headers.get('content-disposition') ?? ''
      const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
      return {
        data: new Uint8Array(await res.arrayBuffer()),
        mime: res.headers.get('content-type') ?? 'application/octet-stream',
        fileName: match ? decodeURIComponent(match[1]) : fileId,
      }
    } catch (e) {
      return { error: errMsg(e) }
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async manifest(): Promise<{ artifacts: ArtifactMetaDto[] } | { error: string }> {
    const scope = this.scope()
    if (!scope) return { error: SCOPE_MISSING }
    try {
      return await this.json<{ artifacts: ArtifactMetaDto[] }>('', scope)
    } catch (e) {
      return { error: errMsg(e) }
    }
  }

  private async json<T>(path: string, query?: Record<string, string>): Promise<T> {
    const res = await this.request(path, query, 'application/json')
    return res.json() as Promise<T>
  }

  private async request(
    path: string,
    query: Record<string, string> | undefined,
    accept: string,
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}/api/artifacts${path}`)
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
    const headers: Record<string, string> = { Accept: accept }
    const token = this.bearer()
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await this.fetchImpl(url.toString(), { headers })
    if (!res.ok) throw new Error(`chat-backend /api/artifacts${path} → HTTP ${res.status}`)
    return res
  }
}

const SCOPE_MISSING = 'Не задан корпус артефактов (contextId или projectId) в текущем ходе'

/** id сегмента, '' для корня-директории, null если путь глубже одного сегмента. */
function parse(path: string): string | null {
  const seg = path.split('/').filter(Boolean)
  if (seg.length === 0) return ''
  return seg.length === 1 ? seg[0] : null
}

function fileInfo(a: ArtifactMetaDto): FileInfo {
  return { path: `/${a.id}`, is_dir: false, modified_at: a.createdAt }
}

// Манифест — ТЕКСТ для LLM: пути относительные (внешний префикс маунта LLM видит сама).
function renderManifest(artifacts: ArtifactMetaDto[]): string {
  const lines = ['# Артефакты', '']
  for (const a of artifacts) {
    const flags = a.isLarge ? ' _(большой — грепай, не читай целиком)_' : ''
    lines.push(`- **${a.name}** (${a.kind}) — \`/${a.id}\`${flags}`)
    if (a.summary) lines.push(`  - ${a.summary}`)
    if (a.files.length) lines.push(`  - файлы: ${a.files.map((f) => f.fileName).join(', ')}`)
  }
  if (artifacts.length === 0) lines.push('_нет артефактов_')
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
