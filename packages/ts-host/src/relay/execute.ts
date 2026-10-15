import { v4 as uuidv4 } from 'uuid'
import type { Client } from '@a2a-js/sdk/client'
import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Part,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
  type TaskStatusUpdateEvent,
} from '@a2a-js/sdk'
import type { A2uiComponent, A2uiAction, A2uiSnapshot, ContextFile } from '../types'
import { dataPart, textPart } from '../parts'
import { extractText, extractA2ui, isStaleTaskError, isTask } from './extract'
import { injectTraceContext } from '../observability/langfuse'

/**
 * Транспорт-агностичный вызов удалённого A2A-агента (relay). НЕ знает про LangChain/deepagents/NestJS
 * и не трогает стор — store-операции делает потребитель по возвращённым `taskId`/`state`. Форвардит
 * вниз HITL-канал action-модели (`message.metadata.a2uiAction`) и негоциацию; поднимает наверх текст +
 * A2UI. Чистая функция над готовым `Client` (легко юнит-тестить с фейком).
 */
export interface RemoteA2aRequest {
  /** Текст запроса/задачи (на естественном языке) сабагенту. */
  query: string
  /**
   * Структурный payload → A2A `data`-part (`message.parts[{kind:'data'}]`). Для schema-aware вызова
   * (structured-tool из `skillsIo`): агент-сервер читает его как `AgentInput.data` и считает без
   * NL-парсинга/диалога. Пусто/отсутствует → обычный текстовый вызов.
   */
  data?: Record<string, unknown>
  /** Стабильный A2A contextId диалога (обычно contextId хода оркестратора). */
  contextId?: string
  /** Resume: childTaskId, если на прошлом ходу сабагент был `input-required` (HITL/wizard). */
  resumeTaskId?: string
  /** HITL вниз: клик/submit формы → `message.metadata.a2uiAction.userAction` (канон ACTIVITY_SNAPSHOT). */
  action?: A2uiAction
  /** Негоциация: формат текста → `configuration.acceptedOutputModes`. */
  acceptedOutputModes?: string[]
  /** Негоциация: каталоги A2UI → `message.metadata.a2uiClientCapabilities.v0.9`. */
  supportedCatalogIds?: string[]
  /** Вложения/контекст → `message.metadata.ai37.context_refs`. */
  contextRefs?: string[]
  /** Манифест приложенных файлов (имена/summary) → `message.metadata.ai37.context_files`. */
  contextFiles?: ContextFile[]
  /**
   * Человеко-гейт → `message.metadata.ai37.confirm_mode`. `auto` → сабагент выполняет oneshot без
   * подтверждения (машинный вызов: MCP-агрегатор); `ask`/отсутствие → диалог+confirm (ход человека).
   * Ставит доверенная граница (агрегатор/оркестратор). НЕ путать с `configuration.blocking` (транспорт).
   */
  confirmMode?: 'ask' | 'auto'
  /** Доп. поля в `message.metadata` (напр. relay hop-guard) — escape hatch. */
  extraMetadata?: Record<string, unknown>
  /**
   * Стрим: обрыв, если от агента дольше этого не пришло ни одного события. Агент на `agent-host`
   * ≥ 0.2.6 шлёт keepalive раз в 20 с, так что живой ход таймер не задевает. Не задано — без таймера.
   */
  idleTimeoutMs?: number
  /** Абсолютный дедлайн вызова (и блокирующего, и стрима); ставят выше бюджета хода агента. */
  requestTimeoutMs?: number
  /**
   * Отмена вызова (ход оркестратора отменён). Relay обрывает поток и шлёт агенту `tasks/cancel`:
   * обрыв HTTP сам по себе агента не останавливает. То же — при срабатывании таймаутов выше.
   */
  signal?: AbortSignal
}

export type RemoteA2aState = 'completed' | 'input-required' | 'failed' | 'message'

export interface RemoteA2aResult {
  text: string
  /** Сырые деревья и/или конверты `A2uiSnapshot` — как отдал сабагент (см. extractA2ui). */
  a2ui: (A2uiComponent | A2uiSnapshot)[]
  /** childTaskId (если ответ — Task); потребитель персистит для resume. */
  taskId?: string
  /**
   * Состояние ответа в словаре 0.3: `completed`/`input-required`/`failed`, прочее (в т.ч. ответ
   * сообщением) — `message`. Нормализовано из числового `TaskState` 1.x.
   */
  state: RemoteA2aState
  /** true, если `resumeTaskId` оказался устаревшим и запрос повторён как свежий диалог. */
  staleResumeDropped: boolean
  /** Сырой ответ в типах `@a2a-js/sdk` 1.x (сервер 0.3 тоже приходит сюда переведённым). */
  raw: Message | Task
}

function buildParams(req: RemoteA2aRequest, withResume: boolean): SendMessageRequest {
  const metadata: Record<string, unknown> = {}
  if (req.supportedCatalogIds?.length) {
    metadata.a2uiClientCapabilities = { 'v0.9': { supportedCatalogIds: req.supportedCatalogIds } }
  }
  // ai37-конверт собираем единым объектом (НЕ перезаписываем по одному полю): context_refs (указатели)
  // + context_files (манифест имён) едут вместе.
  const ai37: Record<string, unknown> = {}
  if (req.contextRefs?.length) ai37.context_refs = req.contextRefs
  if (req.contextFiles?.length) ai37.context_files = req.contextFiles
  // Человеко-гейт: форвардим вниз, чтобы сабагент знал, можно ли считать без confirm (машинный вызов).
  if (req.confirmMode) ai37.confirm_mode = req.confirmMode
  if (Object.keys(ai37).length > 0) metadata.ai37 = ai37
  if (req.action) metadata.a2uiAction = { userAction: req.action }
  if (req.extraMetadata) Object.assign(metadata, req.extraMetadata)
  // Langfuse v4 distributed tracing: кладём W3C trace-context активного turn-спана оркестратора
  // (`traceparent`/`tracestate`) в metadata → суб-агент продолжит ТОТ ЖЕ трейс. {} (no-op), если
  // трассировка выключена.
  Object.assign(metadata, injectTraceContext())

  const parts: Part[] = [textPart(req.query)]
  // Структурный вход: A2A data-part рядом с текстом → сервер прочитает как AgentInput.data.
  if (req.data && Object.keys(req.data).length > 0) {
    parts.push(dataPart(req.data))
  }
  // Пустые contextId/taskId — «не задано» (protobuf-строки не бывают undefined): сервер 1.x и
  // compat-перевод в 0.3 трактуют их как отсутствие.
  const message: Message = {
    messageId: uuidv4(),
    role: Role.ROLE_USER,
    parts,
    contextId: req.contextId ?? '',
    taskId: withResume && req.resumeTaskId ? req.resumeTaskId : '',
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    extensions: [],
    referenceTaskIds: [],
  }
  return {
    tenant: '',
    message,
    // returnImmediately:false — блокирующий вызов, как `blocking: true` в 0.3.
    configuration: req.acceptedOutputModes
      ? {
          acceptedOutputModes: req.acceptedOutputModes,
          taskPushNotificationConfig: undefined,
          returnImmediately: false,
        }
      : undefined,
    metadata: undefined,
  }
}

const STATE_BY_ENUM: Partial<Record<TaskState, RemoteA2aState>> = {
  [TaskState.TASK_STATE_COMPLETED]: 'completed',
  [TaskState.TASK_STATE_INPUT_REQUIRED]: 'input-required',
  [TaskState.TASK_STATE_FAILED]: 'failed',
}

function toState(raw: Message | Task): RemoteA2aState {
  if (!isTask(raw)) return 'message'
  const s = raw.status?.state
  return (s !== undefined && STATE_BY_ENUM[s]) || 'message'
}

function toResult(raw: Message | Task, staleResumeDropped: boolean): RemoteA2aResult {
  return {
    text: extractText(raw),
    a2ui: extractA2ui(raw),
    ...(isTask(raw) ? { taskId: raw.id } : {}),
    state: toState(raw),
    staleResumeDropped,
    raw,
  }
}

/** Ошибка таймаута relay: то же имя, что у `AbortSignal.timeout`, но с понятным текстом. */
function timeoutError(message: string): DOMException {
  return new DOMException(message, 'TimeoutError')
}

/**
 * Сигнал одного вызова relay: абсолютный дедлайн и таймер простоя (`touch()` его переносит).
 * Транспорт получает `signal` и обрывает HTTP; `dispose()` снимает таймеры.
 */
class RelayWatchdog {
  private readonly controller = new AbortController()
  private readonly timers: ReturnType<typeof setTimeout>[] = []
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  private readonly onOuterAbort = (): void => this.abort(this.req.signal?.reason)

  constructor(private readonly req: RemoteA2aRequest) {
    const outer = req.signal
    if (outer?.aborted) this.abort(outer.reason)
    // Сигнал хода живёт дольше вызова (за ход — несколько сабагентов): слушатель снимает dispose().
    else outer?.addEventListener('abort', this.onOuterAbort, { once: true })
    const deadline = req.requestTimeoutMs
    if (deadline !== undefined) {
      this.timers.push(
        setTimeout(() => this.abort(timeoutError(`A2A-агент не ответил за ${deadline} мс`)), deadline),
      )
    }
    this.touch()
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  /** Есть ли что сторожить: без таймаутов и отмены сигнал транспорту не передаём вовсе. */
  get active(): boolean {
    return (
      this.req.requestTimeoutMs !== undefined || this.req.idleTimeoutMs !== undefined || this.req.signal !== undefined
    )
  }

  /** Событие от агента: таймер простоя начинается заново. */
  touch(): void {
    const idle = this.req.idleTimeoutMs
    if (idle === undefined || this.controller.signal.aborted) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.abort(timeoutError(`A2A-агент молчит дольше ${idle} мс`)), idle)
  }

  /** Блокирующему вызову таймер простоя не нужен: событий до ответа там нет. */
  stopIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  dispose(): void {
    this.stopIdle()
    for (const t of this.timers) clearTimeout(t)
    this.req.signal?.removeEventListener('abort', this.onOuterAbort)
  }

  private abort(reason: unknown): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason)
  }
}

function requestOptions(watchdog: RelayWatchdog): { signal: AbortSignal } | undefined {
  return watchdog.active ? { signal: watchdog.signal } : undefined
}

export async function executeRemoteA2a(
  client: Client,
  req: RemoteA2aRequest,
): Promise<RemoteA2aResult> {
  const watchdog = new RelayWatchdog(req)
  watchdog.stopIdle()
  const options = requestOptions(watchdog)
  let staleResumeDropped = false
  let raw: Message | Task
  try {
    try {
      raw = await abortable(client.sendMessage(buildParams(req, true), options), watchdog.signal)
    } catch (e) {
      // Устаревший resume-таск → повторяем как свежий диалог (без taskId). Иначе — пробрасываем.
      if (req.resumeTaskId && isStaleTaskError(e) && !watchdog.signal.aborted) {
        staleResumeDropped = true
        raw = await abortable(client.sendMessage(buildParams(req, false), options), watchdog.signal)
      } else {
        throw e
      }
    }
  } catch (e) {
    // Блокирующий ответ ещё не пришёл, id новой задачи неизвестен — отменить можно только resume.
    if (watchdog.signal.aborted && !staleResumeDropped) cancelRemoteTask(client, req.resumeTaskId)
    throw e
  } finally {
    watchdog.dispose()
  }

  return toResult(raw, staleResumeDropped)
}

/**
 * `tasks/cancel` агенту, не дожидаясь ответа: relay уже бросает ошибку наверх, а агент старого хоста
 * (no-op `cancelTask`) или завершённая задача ответят ошибкой, которая никому не нужна.
 */
function cancelRemoteTask(client: Client, taskId: string | undefined): void {
  if (!taskId) return
  void Promise.resolve()
    .then(() => client.cancelTask({ tenant: '', id: taskId, metadata: undefined }))
    .catch(() => undefined)
}

/**
 * Ждёт `promise`, но бросает причину отмены, как только `signal` сработал. Транспорт тоже получает
 * сигнал и обрывает HTTP; гонка нужна, чтобы relay не зависел от того, как быстро он это сделает.
 */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined)
    throw signal.reason
  }
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** Структурный тул-колл сабагента (для `type:'tool'`). */
export interface RemoteA2aToolCall {
  id: string
  /** Человекочитаемое имя/лейбл для карточки. */
  name: string
  toolName?: string
  args?: unknown
  result?: unknown
  status?: string
  error?: string
}

/** Промежуточное событие прогресса удалённого агента (из A2A-потока). */
export interface RemoteA2aProgressEvent {
  /**
   * `node`/`reasoning` — из `status-update.metadata` (`ai37/node` / `ai37/reasoning`, COT);
   * `text` — дельта ФИНАЛЬНОГО текста ответа из канонических `artifact-update`(append) text-частей
   * (A2A-нативный стрим, без кастомных каналов) → AG-UI `TEXT_MESSAGE_CONTENT`;
   * `tool` — тул-колл сабагента из `status-update.metadata['ai37/tool']` → AG-UI `TOOL_CALL_*`
   * (у A2A нет нативного тул-события; ai37/tool — та же progress-конвенция, что node/reasoning).
   */
  type: 'node' | 'reasoning' | 'text' | 'tool'
  /** Имя ноды (`node`), reasoning-дельта (`reasoning`) или дельта текста ответа (`text`). Для `tool` — ''. */
  value: string
  /** Структура тул-колла — только для `type:'tool'`. */
  tool?: RemoteA2aToolCall
}

/** Применяет `artifact-update` к накопленной задаче: `append` дописывает части, иначе — замена. */
function applyArtifact(task: Task, artifact: Artifact, append: boolean): Task {
  const artifacts = [...(task.artifacts ?? [])]
  const idx = artifacts.findIndex((a) => a.artifactId === artifact.artifactId)
  if (idx >= 0 && append) {
    artifacts[idx] = { ...artifacts[idx], parts: [...artifacts[idx].parts, ...artifact.parts] }
  } else if (idx >= 0) {
    artifacts[idx] = artifact
  } else {
    artifacts.push(artifact)
  }
  return { ...task, artifacts }
}

/**
 * Применяет `status-update` к накопленной задаче так же, как сервер 1.x: новый статус, `metadata`
 * сливается по ключам. Сервер на 1.x отдаёт финал хода после прогресса именно `status-update`
 * (второй `task` в стриме запрещён), и `metadata.state` приходит в нём.
 */
function applyStatus(task: Task, update: TaskStatusUpdateEvent): Task {
  return {
    ...task,
    ...(update.status ? { status: update.status } : {}),
    ...(update.metadata ? { metadata: { ...task.metadata, ...update.metadata } } : {}),
  }
}

/** node/reasoning/tool из `status-update.metadata` (progress-конвенция ai37) → onEvent. */
function forwardStatusMetadata(
  meta: Record<string, unknown> | undefined,
  onEvent: (e: RemoteA2aProgressEvent) => void,
): void {
  const node = meta?.['ai37/node']
  const reasoning = meta?.['ai37/reasoning']
  const tool = meta?.['ai37/tool']
  if (typeof node === 'string') onEvent({ type: 'node', value: node })
  if (typeof reasoning === 'string') onEvent({ type: 'reasoning', value: reasoning })
  if (tool && typeof tool === 'object') {
    onEvent({ type: 'tool', value: '', tool: tool as RemoteA2aToolCall })
  }
}

/**
 * Накапливает финальный `Message | Task` из потока `StreamResponse` (`payload.$case`) и форвардит
 * node/reasoning/tool/text через onEvent.
 */
async function drainStream(
  client: Client,
  stream: AsyncGenerator<StreamResponse, void, undefined>,
  onEvent: (e: RemoteA2aProgressEvent) => void,
  watchdog: RelayWatchdog,
  knownTaskId: string | undefined,
): Promise<Message | Task | undefined> {
  let task: Task | undefined
  let message: Message | undefined
  for (;;) {
    let step: IteratorResult<StreamResponse, void>
    try {
      step = await abortable(stream.next(), watchdog.signal)
    } catch (e) {
      if (watchdog.signal.aborted) {
        // Закрыть генератор, чтобы транспорт отпустил соединение; ошибка его закрытия не важна.
        void stream.return(undefined).catch(() => undefined)
        cancelRemoteTask(client, task?.id || knownTaskId)
      }
      throw e
    }
    if (step.done) break
    // Любое событие, включая keepalive (`status-update working` без metadata), — признак жизни.
    watchdog.touch()
    const payload = step.value.payload
    if (payload?.$case === 'message') {
      message = payload.value
    } else if (payload?.$case === 'task') {
      task = payload.value
    } else if (payload?.$case === 'statusUpdate') {
      const update = payload.value
      forwardStatusMetadata(update.metadata, onEvent)
      if (task && update.taskId === task.id) task = applyStatus(task, update)
    } else if (payload?.$case === 'artifactUpdate') {
      const update = payload.value
      const artifact = update.artifact
      if (!artifact) continue
      // Канон A2A: `append:true` = ИНКРЕМЕНТ (дельта), иначе — ПОЛНЫЙ снапшот (replace). Стрим текста
      // поднимаем ТОЛЬКО при append (part.text = дельта); снапшот-replace как дельту слать нельзя —
      // потребитель их конкатенирует и получит дубли. Финальный текст всё равно соберётся в task и
      // уедет через extractText. data-части (a2ui) не трогаем (уезжают через extractA2ui).
      if (update.append) {
        for (const part of artifact.parts ?? []) {
          if (part.content?.$case === 'text' && part.content.value.length > 0) {
            onEvent({ type: 'text', value: part.content.value })
          }
        }
      }
      if (task && update.taskId === task.id) task = applyArtifact(task, artifact, update.append)
    }
  }
  // Финальный результат: message главнее (как в ResultManager.getFinalResult), иначе накопленный task.
  return message ?? task
}

/**
 * Стрим-вариант `executeRemoteA2a`: вызывает агента по `message/stream` и форвардит промежуточный
 * прогресс/COT (node/reasoning из `status-update.metadata`) через `onEvent`, попутно накапливая
 * финальный `Message | Task`. Контракт результата идентичен `executeRemoteA2a`. Требует у агента
 * `capabilities.streaming: true`. Stale-resume обрабатывается как и в блокирующем варианте.
 */
export async function executeRemoteA2aStreaming(
  client: Client,
  req: RemoteA2aRequest,
  onEvent: (e: RemoteA2aProgressEvent) => void,
): Promise<RemoteA2aResult> {
  const watchdog = new RelayWatchdog(req)
  const options = requestOptions(watchdog)
  let staleResumeDropped = false
  let raw: Message | Task | undefined
  try {
    try {
      const stream = client.sendMessageStream(buildParams(req, true), options)
      raw = await drainStream(client, stream, onEvent, watchdog, req.resumeTaskId)
    } catch (e) {
      if (req.resumeTaskId && isStaleTaskError(e) && !watchdog.signal.aborted) {
        staleResumeDropped = true
        watchdog.touch()
        const stream = client.sendMessageStream(buildParams(req, false), options)
        raw = await drainStream(client, stream, onEvent, watchdog, undefined)
      } else {
        throw e
      }
    }
  } finally {
    watchdog.dispose()
  }
  if (!raw) {
    throw new Error('executeRemoteA2aStreaming: поток не дал финального Message/Task')
  }

  return toResult(raw, staleResumeDropped)
}
