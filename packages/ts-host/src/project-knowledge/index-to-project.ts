import { currentBearer } from '../als'

/**
 * Мост «добавить в базу проекта» в chat-backend (`POST /api/project-knowledge`, план
 * project-knowledge-bridge, срез 3): вложения и артефакты уходят в пул проекта document-service.
 * Мост без состояния; что уже лежит в пуле, решают DS (sha256) и название артефакта.
 *
 * Типы запроса и ответа здесь — контракт, по которому chat-backend реализует маршрут.
 */

/** Тело `POST /api/project-knowledge`. */
export interface ProjectKnowledgeRequest {
  projectId: string
  /** `chat-attachment:` | `project-attachment:` | `artifact:` | `project-artifact:` + id. */
  refs: string[]
}

/** Почему файл нельзя отправить в DS (ответ `not_indexable`). */
export type ProjectKnowledgeNotIndexableReason =
  /** Оригинал вложения не сохранён: файл больше `ATTACHMENT_RAW_MAX_MB`. */
  | 'raw_not_stored'
  /** Формат не входит в `uploadFormats` DS. */
  | 'format_not_accepted'
  | (string & {})

/**
 * Код отказа по ref. Проверки проекта (`access_grant`, `project_private`, `role_forbidden`)
 * относятся ко всем ref запроса, и мост повторяет их в каждом. Отказы DS приходят его кодом
 * (`documents_not_in_plan`, `file_too_large`, …).
 */
export type ProjectKnowledgeRejectCode =
  /** Проект доступен по гранту, а не свой: загрузка создала бы пул в чужой организации. */
  | 'access_grant'
  /** Приватный проект: мост их не индексирует. */
  | 'project_private'
  /** Нужна роль `OWNER` или `EDITOR`. */
  | 'role_forbidden'
  | 'project_not_found'
  /** Вложения или артефакта нет или он недоступен пользователю. */
  | 'ref_not_found'
  /** Ref неизвестного вида. */
  | 'invalid_ref'
  /** Не удалось прикрепить ref чата к проекту. */
  | 'attach_failed'
  | 'documents_not_in_plan'
  | 'upstream_error'
  | (string & {})

/** Результат по одному ref. */
export type ProjectKnowledgeRefResult =
  /** Файл принят DS; распознавание идёт в фоне, статус — в `/documents` проекта. */
  | { ref: string; status: 'sent'; seriesId: string }
  /** Такой документ уже в пуле: артефакт с тем же названием или файл с тем же sha256. */
  | { ref: string; status: 'already_indexed'; seriesId: string }
  | { ref: string; status: 'not_indexable'; reason: ProjectKnowledgeNotIndexableReason }
  /** DS занят приёмом других файлов: повторить через `retryAfterSeconds`. */
  | { ref: string; status: 'busy'; retryAfterSeconds: number }
  | { ref: string; status: 'rejected'; code: ProjectKnowledgeRejectCode }

export type ProjectKnowledgeStatus = ProjectKnowledgeRefResult['status']

/** Ответ 200 `POST /api/project-knowledge`: по результату на каждый ref запроса, в его порядке. */
export interface ProjectKnowledgeResponse {
  projectId: string
  results: ProjectKnowledgeRefResult[]
}

export interface IndexToProjectOptions {
  /** База REST chat-backend. */
  chatBackendUrl: string
  projectId: string
  refs: readonly string[]
  /** user-JWT для форварда. По умолчанию — `currentBearer` из request-scope. */
  bearer?: () => string | undefined
  fetchImpl?: typeof fetch
  /** Таймаут запроса, мс (по умолчанию 120 000: мост сам грузит файлы в DS). */
  timeoutMs?: number
}

/** Отказ запроса целиком; отказы по отдельным ref приходят в результатах, а не ошибкой. */
export type ProjectKnowledgeErrorCode =
  /** Нет user-JWT: отправлять не от чьего имени. */
  | 'no_scope'
  /** 400: тело не прошло проверку. */
  | 'invalid_input'
  /** 401/403. */
  | 'unauthorized'
  /** 404: маршрута нет (chat-backend старее среза 3) или проект не найден. */
  | 'not_found'
  /** Прочие коды и ответ без `results`. */
  | 'upstream_error'
  | 'network_error'

/** Ошибка моста в стиле `ArtifactPublishError`: в тексте только код и статус. */
export class ProjectKnowledgeError extends Error {
  constructor(
    readonly code: ProjectKnowledgeErrorCode,
    readonly status?: number,
    /** Код ошибки chat-backend, если он его вернул. */
    readonly serverCode?: string,
  ) {
    super(
      `indexToProject: ${code}${status ? ` (HTTP ${status}${serverCode ? ` ${serverCode}` : ''})` : ''}`,
    )
    this.name = 'ProjectKnowledgeError'
  }
}

const STATUS_CODES: Record<number, ProjectKnowledgeErrorCode> = {
  400: 'invalid_input',
  401: 'unauthorized',
  403: 'unauthorized',
  404: 'not_found',
}

/**
 * Отправляет вложения и артефакты в базу проекта через мост chat-backend. Проверки доступа к
 * проекту, приватности и роли делает chat-backend; агентам этот вызов пока не нужен, он есть для
 * паритета с пунктом меню UI.
 *
 * ```ts
 * const { results } = await indexToProject({
 *   chatBackendUrl: process.env.CHAT_BACKEND_URL!,
 *   projectId,
 *   refs: ['project-artifact:…'],
 * })
 * ```
 */
export async function indexToProject(
  opts: IndexToProjectOptions,
): Promise<ProjectKnowledgeResponse> {
  const token = (opts.bearer ?? currentBearer)()
  if (!token) throw new ProjectKnowledgeError('no_scope')
  const body: ProjectKnowledgeRequest = { projectId: opts.projectId, refs: [...opts.refs] }
  const res = await send(opts, body, token)
  const payload = (await res.json().catch(() => undefined)) as
    Partial<ProjectKnowledgeResponse & { error: unknown }> | undefined
  if (!res.ok) {
    throw new ProjectKnowledgeError(
      STATUS_CODES[res.status] ?? 'upstream_error',
      res.status,
      serverCode(payload?.error),
    )
  }
  if (!Array.isArray(payload?.results)) {
    throw new ProjectKnowledgeError('upstream_error', res.status)
  }
  return { projectId: payload.projectId ?? opts.projectId, results: payload.results }
}

async function send(
  opts: IndexToProjectOptions,
  body: ProjectKnowledgeRequest,
  token: string,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const url = `${opts.chatBackendUrl.replace(/\/+$/, '')}/api/project-knowledge`
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    })
  } catch {
    throw new ProjectKnowledgeError('network_error')
  }
}

/** Только короткий машинный код: произвольный текст ответа в ошибку не тащим. */
function serverCode(error: unknown): string | undefined {
  return typeof error === 'string' && /^[\w.:-]{1,64}$/.test(error) ? error : undefined
}
