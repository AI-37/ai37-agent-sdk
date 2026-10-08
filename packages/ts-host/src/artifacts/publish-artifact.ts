import { createHash } from 'node:crypto'
import { currentBearer, currentTurnContext } from '../als'

/** Файл артефакта: бинарное представление, когда формат уже не markdown (ZIP, исходная таблица). */
export interface PublishArtifactFile {
  fileName: string
  /** MIME; по умолчанию `application/octet-stream`. */
  mime?: string
  data: Uint8Array
}

export interface PublishArtifactOptions {
  /** База REST chat-backend (тот же хост, что у StoreBackend'ов вложений). */
  baseUrl: string
  /** Тип домена: `lift-report`, `teplo-report`, `pdn-policy`, … (строчные латиница, цифры, `.-_`). */
  kind: string
  /** Человеческое имя: заголовок карточки и имя файла выгрузки. */
  name: string
  /** Текстовое представление — его читают другие агенты, по нему поиск и DOCX-выгрузка. */
  markdown: string
  /** id агента из реестра (подпись для людей и аудита, на доступ не влияет). */
  producerAgentId: string
  producerSkillId?: string
  /** Короткая выжимка; по умолчанию chat-backend берёт первый заголовок markdown. */
  summary?: string
  /** DOCX из markdown chat-backend рендерит сам — файлы нужны, только когда формат не markdown. */
  files?: PublishArtifactFile[]
  /**
   * Положить сразу в проект треда. Действует, только если тред в проекте и у пользователя есть
   * право записи; иначе артефакт ляжет на полку чата. По умолчанию — полка чата.
   */
  project?: boolean
  /** Предыдущая версия того же результата (артефакты неизменяемы, новая версия — новый артефакт). */
  supersedesId?: string
  /** Небольшой JSON-объект (≤ 16 КБ) — доменные метаданные. */
  metadata?: Record<string, unknown>
  /**
   * Ключ идемпотентности. По умолчанию выводится из хода и содержимого, поэтому повтор того же
   * вызова (ретрай после обрыва сети) вернёт уже записанный артефакт, а не создаст дубль.
   */
  idempotencyKey?: string
  /** Переопределить диалог/ход. По умолчанию — из request-scope хода (`currentTurnContext`). */
  contextId?: string
  taskId?: string
  /** user-JWT для форварда. По умолчанию — `currentBearer` из request-scope. */
  bearer?: () => string | undefined
  fetchImpl?: typeof fetch
  /** Таймаут запроса, мс (по умолчанию 30 000). */
  timeoutMs?: number
}

export interface PublishedArtifactFile {
  id: string
  fileName: string
  mime: string
  bytes: number
  sha256: string
}

/** Что вернул chat-backend + готовые ref и ссылка для ответа агента. */
export interface PublishedArtifact {
  id: string
  kind: string
  name: string
  summary: string
  scope: 'chat' | 'project'
  projectId?: string
  contextId: string
  sha256: string
  createdAt: string
  expiresAt?: string
  files: PublishedArtifactFile[]
  /** false — это повтор: артефакт с тем же ключом и содержимым уже был опубликован. */
  created: boolean
  /** ref для `context_refs`: `artifact:<id>` или `project-artifact:<id>`. */
  ref: string
  /** Относительная ссылка на артефакт в chat-backend (markdown-fallback вместо карточки). */
  url: string
}

export type ArtifactPublishErrorCode =
  /** Нет user-JWT или диалога в request-scope — публиковать не от чьего имени. */
  | 'no_scope'
  /** chat-backend отклонил поля (400). */
  | 'invalid_input'
  /** 401/403. */
  | 'unauthorized'
  /** Тред или `supersedesId` не найден у этого пользователя (404). */
  | 'not_found'
  /** Тот же ключ идемпотентности с другим содержимым (409). */
  | 'conflict'
  /** Файл, число файлов или markdown больше лимита (413). */
  | 'too_large'
  /** Лимит артефактов в диалоге (429). */
  | 'rate_limited'
  /** Объектное хранилище chat-backend не настроено, а файлы переданы (503). */
  | 'storage_unavailable'
  /** Прочие 5xx и неожиданные ответы. */
  | 'upstream_error'
  /** Сеть или таймаут — безопасно повторить тем же вызовом (ключ идемпотентности тот же). */
  | 'network_error'

/**
 * Ошибка публикации. `message` несёт только код и статус: тело артефакта и ответ сервера целиком в
 * текст ошибки (а значит, в логи) не попадают.
 */
export class ArtifactPublishError extends Error {
  constructor(
    readonly code: ArtifactPublishErrorCode,
    readonly status?: number,
    /** Код ошибки chat-backend (`thread_not_found`, `invalid_kind`, …), если он его вернул. */
    readonly serverCode?: string,
  ) {
    super(
      `publishArtifact: ${code}${status ? ` (HTTP ${status}${serverCode ? ` ${serverCode}` : ''})` : ''}`,
    )
    this.name = 'ArtifactPublishError'
  }
}

const STATUS_CODES: Record<number, ArtifactPublishErrorCode> = {
  400: 'invalid_input',
  401: 'unauthorized',
  403: 'unauthorized',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  429: 'rate_limited',
  503: 'storage_unavailable',
}

/** HTTP-статус ответа → код ошибки SDK. */
export function artifactErrorCode(status: number): ArtifactPublishErrorCode {
  return STATUS_CODES[status] ?? 'upstream_error'
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Ключ по умолчанию: ход + содержимое. Тот же ход с тем же результатом — тот же ключ (ретрай не
 * плодит дубль); другой результат в том же ходе — другой ключ (это другой артефакт).
 */
export function defaultIdempotencyKey(
  opts: Pick<PublishArtifactOptions, 'kind' | 'name' | 'markdown' | 'files'>,
  contextId: string,
  taskId: string | undefined,
): string {
  const parts = [
    contextId,
    taskId ?? '',
    opts.kind,
    opts.name,
    sha256Hex(opts.markdown),
    ...(opts.files ?? []).map((f) => sha256Hex(f.data)).sort(),
  ]
  return `auto:${sha256Hex(parts.join('\n'))}`
}

function buildForm(
  opts: PublishArtifactOptions,
  scope: { contextId: string; taskId?: string; idempotencyKey: string },
): FormData {
  const form = new FormData()
  const fields: Record<string, string | undefined> = {
    contextId: scope.contextId,
    taskId: scope.taskId,
    idempotencyKey: scope.idempotencyKey,
    kind: opts.kind,
    name: opts.name,
    markdown: opts.markdown,
    producerAgentId: opts.producerAgentId,
    producerSkillId: opts.producerSkillId,
    summary: opts.summary,
    supersedesId: opts.supersedesId,
    metadata: opts.metadata ? JSON.stringify(opts.metadata) : undefined,
    project: opts.project ? 'true' : undefined,
  }
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, v)
  for (const f of opts.files ?? []) {
    const blob = new Blob([f.data as BlobPart], { type: f.mime ?? 'application/octet-stream' })
    form.append('files', blob, f.fileName)
  }
  return form
}

async function serverCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown }
    // Только короткий машинный код: произвольный текст ответа в ошибку не тащим.
    return typeof body.error === 'string' && /^[\w.:-]{1,64}$/.test(body.error)
      ? body.error
      : undefined
  } catch {
    return undefined
  }
}

async function send(
  opts: PublishArtifactOptions,
  form: FormData,
  token: string,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/artifacts`
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    })
  } catch {
    throw new ArtifactPublishError('network_error')
  }
}

/**
 * Публикует результат хода как артефакт в выходную полку chat-backend (`POST /api/artifacts`, план
 * files-and-artifacts-layer §3.3). Публикация идёт от имени пользователя: user-JWT и диалог берутся
 * из request-scope хода, а без них функция отказывает (`no_scope`), а не публикует «от никого».
 *
 * Байты по A2A не идут: в ответ агента кладётся карточка артефакта (A2UI) или markdown-ссылка
 * `url` как fallback; другие агенты читают артефакт по `ref`.
 *
 * ```ts
 * const artifact = await publishArtifact({
 *   baseUrl: process.env.CHAT_BACKEND_URL!,
 *   kind: 'lift-report',
 *   name: 'Протокол расчёта лифтов',
 *   markdown: report,
 *   producerAgentId: 'elevator-calc',
 * })
 * ```
 */
export async function publishArtifact(opts: PublishArtifactOptions): Promise<PublishedArtifact> {
  const turn = currentTurnContext()
  const token = (opts.bearer ?? currentBearer)()
  const contextId = opts.contextId ?? turn?.contextId
  const taskId = opts.taskId ?? turn?.taskId
  if (!token || !contextId) throw new ArtifactPublishError('no_scope')

  const idempotencyKey = opts.idempotencyKey ?? defaultIdempotencyKey(opts, contextId, taskId)
  const res = await send(opts, buildForm(opts, { contextId, taskId, idempotencyKey }), token)
  if (!res.ok) {
    throw new ArtifactPublishError(artifactErrorCode(res.status), res.status, await serverCode(res))
  }
  const { artifact } = (await res.json()) as {
    artifact?: Omit<PublishedArtifact, 'created' | 'ref' | 'url'>
  }
  if (!artifact?.id) throw new ArtifactPublishError('upstream_error', res.status)
  return {
    ...artifact,
    created: res.status === 201,
    ref: `${artifact.scope === 'project' ? 'project-artifact' : 'artifact'}:${artifact.id}`,
    url: `/api/artifacts/${artifact.id}`,
  }
}
