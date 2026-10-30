/**
 * Пул проекта в document-service: загрузка файла и поиск документа по названию (план
 * project-knowledge-bridge, срез 2; контракт DS — `POST/GET /api/project-pools/{projectKey}/documents`).
 *
 * Одна реализация на всех: мост chat-backend грузит с JWT пользователя, фоновые задачи агентов —
 * со служебным токеном (`serviceToken`). Организацию запрос не передаёт: DS берёт её из токена
 * или из записи пула.
 */

/** Файл для загрузки: байты, Blob или поток с заранее известным размером. */
export type ProjectPoolFile =
  | Uint8Array
  | Blob
  | {
      stream: ReadableStream<Uint8Array>
      /** Размер в байтах: DS без Content-Length тело не читает (411). */
      size: number
    }

export interface UploadToProjectPoolOptions {
  /** База document-service (in-cluster). */
  documentServiceUrl: string
  /** Ключ пула: id проекта chat-backend в нижнем регистре. */
  projectKey: string
  file: ProjectPoolFile
  /** Имя файла с расширением: по расширению DS выбирает формат, без него — название документа. */
  fileName: string
  /** Название пула, если загрузка его создаёт. На существующий пул не влияет. */
  projectName?: string
  /** JWT пользователя (мост chat-backend) или служебный токен (фоновая задача). */
  bearer: string
  /**
   * MIME тела. По умолчанию `application/pdf` для `.pdf`, иначе `application/octet-stream`: DS
   * принимает PDF только с точным типом, остальные форматы проверяет по содержимому.
   */
  contentType?: string
  fetchImpl?: typeof fetch
  /** Таймаут запроса, мс (по умолчанию 120 000: тело идёт целиком). */
  timeoutMs?: number
}

/** Документ с тем же содержимым (sha256) уже лежит в пуле: DS ответил 409 `duplicate`. */
export interface ProjectPoolDuplicate {
  /** id серии документа в DS. */
  id: string
  title: string
}

export type ProjectPoolUploadResult = { seriesId: string } | { duplicateOf: ProjectPoolDuplicate }

/**
 * Код ошибки — `code` из тела ответа DS, как есть. Известные перечислены, остальные проходят
 * строкой. Свои коды SDK: `network_error` (сеть, таймаут) и `upstream_error` (ответ без кода).
 */
export type ProjectPoolErrorCode =
  /** 503: процесс DS принимает другие файлы; повторить через `retryAfterSeconds`. */
  | 'upload_busy'
  | 'billing_unavailable'
  /** Служебный клиент: пула с таким ключом ещё нет, а создавать его он не вправе. */
  | 'pool_not_found'
  | 'ambiguous_project_pool'
  | 'documents_not_in_plan'
  | 'forbidden_role'
  | 'organization_required'
  | 'unauthorized'
  | 'invalid_project_key'
  | 'invalid_query'
  | 'unsupported_format'
  | 'invalid_file_name'
  | 'invalid_file'
  | 'empty_file'
  | 'file_too_large'
  | 'length_required'
  | 'DOCUMENT_LIMIT_REACHED'
  | 'not_found'
  | 'network_error'
  | 'upstream_error'
  | (string & {})

/**
 * Отказ DS. В `message` только код и статус: текст ответа и имя файла в ошибку (а значит, в логи)
 * не попадают.
 */
export class ProjectPoolError extends Error {
  constructor(
    readonly code: ProjectPoolErrorCode,
    readonly status?: number,
    /** Через сколько секунд повторить (`upload_busy`): из `Retry-After`, иначе из тела. */
    readonly retryAfterSeconds?: number,
  ) {
    super(`project pool: ${code}${status ? ` (HTTP ${status})` : ''}`)
    this.name = 'ProjectPoolError'
  }
}

/**
 * Загружает файл в пул проекта DS. Тело идёт потоком, без multipart: имя в `X-File-Name`
 * (encodeURIComponent), размер в `Content-Length`. Повтор того же содержимого не ошибка: DS
 * отвечает `duplicate`, и функция возвращает `duplicateOf`.
 *
 * ```ts
 * const token = await serviceToken({ issuer, clientId, clientSecret })
 * const res = await uploadToProjectPool({ documentServiceUrl, projectKey, file, fileName, bearer: token })
 * const seriesId = 'seriesId' in res ? res.seriesId : res.duplicateOf.id
 * ```
 */
export async function uploadToProjectPool(
  opts: UploadToProjectPoolOptions,
): Promise<ProjectPoolUploadResult> {
  const { body, size } = uploadBody(opts.file)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.bearer}`,
    Accept: 'application/json',
    'Content-Type': opts.contentType ?? defaultContentType(opts.fileName),
    'Content-Length': String(size),
    'X-File-Name': encodeURIComponent(opts.fileName),
  }
  if (opts.projectName) headers['X-Project-Name'] = encodeURIComponent(opts.projectName)
  const init: RequestInit & { duplex?: 'half' } = { method: 'POST', headers, body }
  // Поток в fetch Node уходит только полудуплексом.
  if (body instanceof ReadableStream) init.duplex = 'half'

  const res = await call(opts, poolUrl(opts), init, opts.timeoutMs ?? 120_000)
  const payload = await readJson(res)
  if (res.status === 201) {
    const id = (payload as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string' || !id) throw new ProjectPoolError('upstream_error', res.status)
    return { seriesId: id }
  }
  const duplicate = duplicateOf(res.status, payload)
  if (duplicate) return { duplicateOf: duplicate }
  throw poolError(res, payload)
}

export interface FindProjectDocumentByTitleOptions {
  documentServiceUrl: string
  projectKey: string
  /** Название документа в DS: имя файла без расширения. Сравнивается целиком. */
  title: string
  bearer: string
  fetchImpl?: typeof fetch
  /** Таймаут одного запроса, мс (по умолчанию 30 000). */
  timeoutMs?: number
}

export type ProjectPoolDocumentState =
  'queued' | 'processing' | 'ready' | 'empty' | 'error' | 'stopped'

/** Строка реестра пула (`GET /api/project-pools/{key}/documents`). */
export interface ProjectPoolDocument {
  /** id серии документа в DS. */
  id: string
  title: string
  state: ProjectPoolDocumentState
  stage: string
  createdAt: string
  pageCount: number
  readyPages: number
  author: string | null
}

/** Страница по максимуму DS и потолок страниц: поиск подстрочный, точное имя ищем среди найденного. */
const PAGE_SIZE = 50
const MAX_PAGES = 20

/**
 * Документ пула с точно таким названием или null. DS ищет по подстроке без учёта регистра, поэтому
 * выдача сверяется с названием целиком; страницы листаются, пока совпадение не найдено. Пула ещё
 * нет — DS отдаёт пустую страницу, и ответ null.
 */
export async function findProjectDocumentByTitle(
  opts: FindProjectDocumentByTitleOptions,
): Promise<ProjectPoolDocument | null> {
  const title = opts.title.trim()
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(poolUrl(opts))
    url.searchParams.set('search', title)
    url.searchParams.set('take', String(PAGE_SIZE))
    if (cursor) url.searchParams.set('cursor', cursor)
    const init = {
      headers: { Authorization: `Bearer ${opts.bearer}`, Accept: 'application/json' },
    }
    const res = await call(opts, url.toString(), init, opts.timeoutMs ?? 30_000)
    const payload = await readJson(res)
    if (!res.ok) throw poolError(res, payload)
    const { documents, nextCursor } = (payload ?? {}) as {
      documents?: ProjectPoolDocument[]
      nextCursor?: string | null
    }
    if (!Array.isArray(documents)) throw new ProjectPoolError('upstream_error', res.status)
    const found = documents.find((doc) => doc.title === title)
    if (found) return found
    if (!nextCursor) return null
    cursor = nextCursor
  }
  return null
}

// ── helpers ────────────────────────────────────────────────────────────────────

function poolUrl(opts: { documentServiceUrl: string; projectKey: string }): string {
  const base = opts.documentServiceUrl.replace(/\/+$/, '')
  return `${base}/api/project-pools/${encodeURIComponent(opts.projectKey)}/documents`
}

function uploadBody(file: ProjectPoolFile): { body: BodyInit; size: number } {
  if (file instanceof Uint8Array) return { body: file as BodyInit, size: file.byteLength }
  if (file instanceof Blob) return { body: file, size: file.size }
  return { body: file.stream, size: file.size }
}

function defaultContentType(fileName: string): string {
  return /\.pdf$/i.test(fileName.trim()) ? 'application/pdf' : 'application/octet-stream'
}

async function call(
  opts: { fetchImpl?: typeof fetch },
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    throw new ProjectPoolError('network_error')
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

function duplicateOf(status: number, payload: unknown): ProjectPoolDuplicate | null {
  const body = payload as { code?: unknown; duplicate?: { id?: unknown; title?: unknown } }
  if (status !== 409 || body?.code !== 'duplicate') return null
  const { id, title } = body.duplicate ?? {}
  return typeof id === 'string' && id ? { id, title: typeof title === 'string' ? title : '' } : null
}

function poolError(res: Response, payload: unknown): ProjectPoolError {
  const code = (payload as { code?: unknown } | undefined)?.code
  // Только короткий машинный код: произвольный текст ответа в ошибку не тащим.
  const known = typeof code === 'string' && /^[\w.:-]{1,64}$/.test(code) ? code : 'upstream_error'
  return new ProjectPoolError(known, res.status, retryAfter(res, payload))
}

function retryAfter(res: Response, payload: unknown): number | undefined {
  const header = Number(res.headers.get('retry-after'))
  if (Number.isFinite(header) && header > 0) return header
  const fromBody = (payload as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds
  return typeof fromBody === 'number' && fromBody > 0 ? fromBody : undefined
}
