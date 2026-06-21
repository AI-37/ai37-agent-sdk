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

/** DTO REST истории chat-backend. */
interface ProjectDto {
  id: string
  slug: string | null
  title: string
  createdAt: string
  updatedAt: string
}
interface ThreadDto {
  id: string
  contextId: string
  slug: string | null
  title: string | null
  projectId: string | null
  createdAt: string
  updatedAt: string
}
interface ChatMessageDto {
  role: string
  content: string
  a2uiArtifacts: unknown
  createdAt: string
}
/** Серверное FTS-совпадение (grep). */
interface ChatGrepHit {
  contextId: string
  threadSlug: string | null
  threadTitle: string | null
  projectSlug: string | null
  snippet: string
}

export interface ChatStoreBackendOptions {
  /**
   * База REST chat-backend (history API). Backend ходит в вложенные ресурсы:
   * `/api/projects/`, `/api/projects/:slug/`, `/api/projects/:slug/threads/[:ts]`, `/api/threads/`,
   * `/api/threads/:slug`, с серверным поиском через `?name=` (glob) и `?content=` (grep, FTS).
   */
  baseUrl: string
  /** user-JWT для форварда (приватность per-user). По умолчанию `currentBearer` из request-scope. */
  bearer?: () => string | undefined
  /** fetch (по умолчанию глобальный). */
  fetchImpl?: typeof fetch
}

const READ_ONLY = 'ChatStoreBackend доступен только для чтения (история чатов/проектов)'

/**
 * StoreBackend поверх history-API chat-backend: read-only доступ агентов к истории чатов и проектам
 * через файловую абстракцию deepagents `CompositeBackend`. ВСЕ операции серверные (включая поиск) —
 * backend лишь маппит virtual-path + query на REST endpoint и форматирует ответ. Чат — основная
 * сущность, проект — опциональная группировка.
 *
 * Виртуальная ФС (якоря `projects`/`threads` в пути):
 * - `/projects/`                          — проекты;
 * - `/projects/{slug}/`                   — проект (его чаты);
 * - `/projects/{slug}/threads/`           — чаты проекта;
 * - `/projects/{slug}/threads/{ts}/`      — чат в проекте;
 * - `/threads/`                           — чаты вне проектов;
 * - `/threads/{ts}/`                      — чат вне проекта.
 *
 * Операции:
 * - `ls`   — структурный листинг (FileInfo);
 * - `read` — markdown: индекс проектов/чатов или расшифровка переписки; offset/limit режут строки;
 * - `glob(pat, path)` — серверный поиск по ИМЕНИ (`?name=`, ILIKE) → FileInfo[];
 * - `grep(pat, path)` — серверный full-text по СОДЕРЖИМОМУ (`?content=`, Postgres-FTS) → GrepMatch[];
 * - `write/edit` — read-only (ошибка).
 *
 * Монтирование (сохраняет якоря после обрезки префикса CompositeBackend):
 * ```ts
 * new CompositeBackend(new StateBackend(), {
 *   "/history/": new ChatStoreBackend({ baseUrl: process.env.CHAT_BACKEND_URL! }),
 * })
 * // агент: ls('/history/projects/'), read('/history/projects/{slug}/threads/{ts}/'),
 * //        grep('лифты','/history/projects/'), glob('расч','/history/threads/')
 * ```
 */
export class ChatStoreBackend implements StoreBackend {
  private readonly baseUrl: string
  private readonly bearer: () => string | undefined
  private readonly fetchImpl: typeof fetch

  constructor(opts: ChatStoreBackendOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.bearer = opts.bearer ?? currentBearer
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  // ── ls ─────────────────────────────────────────────────────────────────────
  async ls(path: string): Promise<LsResult> {
    try {
      const p = parsePath(path)
      switch (p.kind) {
        case 'root':
          return { files: [dir('/projects/'), dir('/threads/')] }
        case 'projects': {
          const { projects } = await this.api<{ projects: ProjectDto[] }>('/api/projects/')
          return { files: projects.map((pr) => dir(projectDir(pr))) }
        }
        case 'project':
          // содержимое проекта = поддиректория threads/
          return { files: [dir(`/projects/${p.projectSlug}/threads/`)] }
        case 'project-threads': {
          const { threads } = await this.api<{ threads: ThreadDto[] }>(
            `/api/projects/${enc(p.projectSlug)}/threads/`,
          )
          return { files: threads.map((t) => file(`/projects/${p.projectSlug}/threads/${threadSeg(t)}`, t)) }
        }
        case 'threads': {
          const { threads } = await this.api<{ threads: ThreadDto[] }>('/api/threads/?projectId=none')
          return { files: threads.map((t) => file(`/threads/${threadSeg(t)}`, t)) }
        }
        default:
          return { error: `Не директория: ${path}` }
      }
    } catch (e) {
      return { error: errMsg(e) }
    }
  }

  // ── read ───────────────────────────────────────────────────────────────────
  async read(path: string, offset?: number, limit?: number): Promise<ReadResult> {
    try {
      const md = await this.renderRead(parsePath(path), path)
      if (md === null) return { error: `Не найдено: ${path}` }
      return { content: sliceLines(md, offset, limit), mimeType: 'text/markdown' }
    } catch (e) {
      return { error: errMsg(e) }
    }
  }

  // ── glob (по имени, серверный ILIKE) ─────────────────────────────────────────
  async glob(pattern: string, path?: string): Promise<GlobResult> {
    try {
      const name = stripGlob(pattern)
      const p = parsePath(path ?? '/')
      if (p.kind === 'root' || p.kind === 'projects') {
        const { projects } = await this.api<{ projects: ProjectDto[] }>('/api/projects/', { name })
        return { files: projects.map((pr) => dir(projectDir(pr))) }
      }
      if (p.kind === 'project' || p.kind === 'project-threads') {
        const { threads } = await this.api<{ threads: ThreadDto[] }>(
          `/api/projects/${enc(p.projectSlug)}/threads/`,
          { name },
        )
        return { files: threads.map((t) => file(`/projects/${p.projectSlug}/threads/${threadSeg(t)}`, t)) }
      }
      if (p.kind === 'threads') {
        const { threads } = await this.api<{ threads: ThreadDto[] }>('/api/threads/', {
          name,
          projectId: 'none',
        })
        return { files: threads.map((t) => file(`/threads/${threadSeg(t)}`, t)) }
      }
      return { files: [] }
    } catch (e) {
      return { error: errMsg(e) }
    }
  }

  // ── grep (по содержимому, серверный FTS) ─────────────────────────────────────
  async grep(pattern: string, path?: string | null): Promise<GrepResult> {
    try {
      const p = parsePath(path ?? '/')
      let hits: ChatGrepHit[]
      if (p.kind === 'project' || p.kind === 'project-threads') {
        hits = (
          await this.api<{ matches: ChatGrepHit[] }>(
            `/api/projects/${enc(p.projectSlug)}/threads/`,
            { content: pattern },
          )
        ).matches
      } else if (p.kind === 'threads') {
        hits = (
          await this.api<{ matches: ChatGrepHit[] }>('/api/threads/', {
            content: pattern,
            projectId: 'none',
          })
        ).matches
      } else {
        // root/projects/thread — поиск по всем чатам пользователя
        hits = (await this.api<{ matches: ChatGrepHit[] }>('/api/projects/', { content: pattern }))
          .matches
      }
      return {
        matches: hits.map<GrepMatch>((h) => ({
          path: grepHitPath(h),
          line: 1,
          text: `[${h.threadTitle ?? 'чат'}] ${oneLine(h.snippet)}`,
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
  // История — markdown-текст (read с пагинацией); raw-бинарь не поддерживаем.
  readRaw(): Promise<ReadRawResult> {
    return Promise.resolve({ error: READ_ONLY })
  }

  // ── рендереры read ────────────────────────────────────────────────────────────
  private async renderRead(p: Parsed, raw: string): Promise<string | null> {
    switch (p.kind) {
      case 'root': {
        const { projects } = await this.api<{ projects: ProjectDto[] }>('/api/projects/')
        const lines = ['# История', '', '## Проекты']
        for (const pr of projects) lines.push(`- ${pr.title} — \`/projects/${projSeg(pr)}/\``)
        if (projects.length === 0) lines.push('_нет проектов_')
        lines.push('', '## Чаты вне проектов — `/threads/`')
        return lines.join('\n')
      }
      case 'projects': {
        const { projects } = await this.api<{ projects: ProjectDto[] }>('/api/projects/')
        const lines = ['# Проекты', '']
        for (const pr of projects) lines.push(`- ${pr.title} — \`/projects/${projSeg(pr)}/\``)
        if (projects.length === 0) lines.push('_нет проектов_')
        return lines.join('\n')
      }
      case 'project': {
        const { project } = await this.api<{ project: ProjectDto }>(
          `/api/projects/${enc(p.projectSlug)}/`,
        )
        const { threads } = await this.api<{ threads: ThreadDto[] }>(
          `/api/projects/${enc(p.projectSlug)}/threads/`,
        )
        return renderThreadList(`# Проект: ${project.title}`, threads, `/projects/${p.projectSlug}/threads`)
      }
      case 'project-threads': {
        const { threads } = await this.api<{ threads: ThreadDto[] }>(
          `/api/projects/${enc(p.projectSlug)}/threads/`,
        )
        return renderThreadList('# Чаты проекта', threads, `/projects/${p.projectSlug}/threads`)
      }
      case 'threads': {
        const { threads } = await this.api<{ threads: ThreadDto[] }>('/api/threads/?projectId=none')
        return renderThreadList('# Чаты вне проектов', threads, '/threads')
      }
      case 'project-thread': {
        const { messages } = await this.api<{ messages: ChatMessageDto[] }>(
          `/api/projects/${enc(p.projectSlug)}/threads/${enc(p.threadSlug)}`,
        )
        return renderChat(p.threadSlug, messages)
      }
      case 'thread': {
        const { messages } = await this.api<{ thread: ThreadDto; messages: ChatMessageDto[] }>(
          `/api/threads/${enc(p.threadSlug)}`,
        )
        return renderChat(p.threadSlug, messages)
      }
      default:
        return null
    }
    void raw
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────────
  private async api<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    if (query) {
      for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v)
    }
    const headers: Record<string, string> = { Accept: 'application/json' }
    const token = this.bearer()
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await this.fetchImpl(url.toString(), { headers })
    if (!res.ok) throw new Error(`chat-backend ${path} → HTTP ${res.status}`)
    return res.json() as Promise<T>
  }
}

// ── path parsing (толерантно к scope-обрезке: ищем якоря в сегментах) ────────────
type Parsed =
  | { kind: 'root' }
  | { kind: 'projects' }
  | { kind: 'project'; projectSlug: string }
  | { kind: 'project-threads'; projectSlug: string }
  | { kind: 'project-thread'; projectSlug: string; threadSlug: string }
  | { kind: 'threads' }
  | { kind: 'thread'; threadSlug: string }
  | { kind: 'unknown' }

function parsePath(path: string): Parsed {
  const seg = path.split('/').filter(Boolean)
  if (seg.length === 0) return { kind: 'root' }
  const i = seg.findIndex((s) => s === 'projects' || s === 'threads')
  if (i === -1) return { kind: 'unknown' }
  if (seg[i] === 'projects') {
    const projectSlug = seg[i + 1]
    if (!projectSlug) return { kind: 'projects' }
    const sub = seg[i + 2]
    if (!sub) return { kind: 'project', projectSlug }
    if (sub === 'threads') {
      const threadSlug = seg[i + 3]
      return threadSlug
        ? { kind: 'project-thread', projectSlug, threadSlug }
        : { kind: 'project-threads', projectSlug }
    }
    return { kind: 'unknown' }
  }
  const threadSlug = seg[i + 1]
  return threadSlug ? { kind: 'thread', threadSlug } : { kind: 'threads' }
}

// ── helpers ─────────────────────────────────────────────────────────────────────
function dir(path: string): FileInfo {
  return { path, is_dir: true }
}
function file(path: string, t: ThreadDto): FileInfo {
  return { path, is_dir: false, modified_at: t.updatedAt }
}
function projSeg(p: ProjectDto): string {
  return p.slug ?? p.id
}
function projectDir(p: ProjectDto): string {
  return `/projects/${projSeg(p)}/`
}
function threadSeg(t: ThreadDto): string {
  return t.slug ?? t.contextId
}
function grepHitPath(h: ChatGrepHit): string {
  const ts = h.threadSlug ?? h.contextId
  return h.projectSlug ? `/projects/${h.projectSlug}/threads/${ts}` : `/threads/${ts}`
}
function renderThreadList(header: string, threads: ThreadDto[], base: string): string {
  const lines = [header, '']
  for (const t of threads) {
    lines.push(`- ${t.title ?? 'Без названия'} — \`${base}/${threadSeg(t)}\` (обновлён: ${t.updatedAt})`)
  }
  if (threads.length === 0) lines.push('_нет чатов_')
  return lines.join('\n')
}
function renderChat(slug: string, messages: ChatMessageDto[]): string {
  const lines = [`# Чат ${slug}`, '']
  for (const m of messages) {
    const role = m.role === 'user' ? 'Пользователь' : m.role === 'assistant' ? 'Ассистент' : m.role
    lines.push(`**${role}:** ${typeof m.content === 'string' ? m.content : ''}`, '')
  }
  if (messages.length === 0) lines.push('_пусто_')
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
/** glob-маска → подстрока для серверного ILIKE (сервер ищет contains, спецсимволы glob убираем). */
function stripGlob(pattern: string): string {
  return pattern.replace(/[*?]/g, '').trim()
}
function sliceLines(content: string, offset?: number, limit?: number): string {
  if (!offset && limit === undefined) return content
  const lines = content.split('\n')
  const start = offset ?? 0
  const end = limit === undefined ? lines.length : start + limit
  return lines.slice(start, end).join('\n')
}
