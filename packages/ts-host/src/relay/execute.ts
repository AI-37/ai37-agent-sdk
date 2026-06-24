import { v4 as uuidv4 } from 'uuid'
import type { Client } from '@a2a-js/sdk/client'
import type { Message, Task } from '@a2a-js/sdk'
import type { A2uiComponent, A2uiAction, ContextFile } from '../types'
import { extractText, extractA2ui, isStaleTaskError } from './extract'
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
  /** Доп. поля в `message.metadata` (напр. relay hop-guard) — escape hatch. */
  extraMetadata?: Record<string, unknown>
}

export type RemoteA2aState = 'completed' | 'input-required' | 'failed' | 'message'

export interface RemoteA2aResult {
  text: string
  a2ui: A2uiComponent[]
  /** childTaskId (если ответ — Task); потребитель персистит для resume. */
  taskId?: string
  state: RemoteA2aState
  /** true, если `resumeTaskId` оказался устаревшим и запрос повторён как свежий диалог. */
  staleResumeDropped: boolean
  raw: Message | Task
}

function buildParams(req: RemoteA2aRequest, withResume: boolean): Parameters<Client['sendMessage']>[0] {
  const metadata: Record<string, unknown> = {}
  if (req.supportedCatalogIds?.length) {
    metadata.a2uiClientCapabilities = { 'v0.9': { supportedCatalogIds: req.supportedCatalogIds } }
  }
  // ai37-конверт собираем единым объектом (НЕ перезаписываем по одному полю): context_refs (указатели)
  // + context_files (манифест имён) едут вместе.
  const ai37: Record<string, unknown> = {}
  if (req.contextRefs?.length) ai37.context_refs = req.contextRefs
  if (req.contextFiles?.length) ai37.context_files = req.contextFiles
  if (Object.keys(ai37).length > 0) metadata.ai37 = ai37
  if (req.action) metadata.a2uiAction = { userAction: req.action }
  if (req.extraMetadata) Object.assign(metadata, req.extraMetadata)
  // Langfuse v4 distributed tracing: кладём W3C trace-context активного turn-спана оркестратора
  // (`traceparent`/`tracestate`) в metadata → суб-агент продолжит ТОТ ЖЕ трейс. {} (no-op), если
  // трассировка выключена.
  Object.assign(metadata, injectTraceContext())

  const message = {
    kind: 'message' as const,
    role: 'user' as const,
    messageId: uuidv4(),
    parts: [{ kind: 'text' as const, text: req.query }],
    ...(req.contextId ? { contextId: req.contextId } : {}),
    ...(withResume && req.resumeTaskId ? { taskId: req.resumeTaskId } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
  return {
    message,
    ...(req.acceptedOutputModes ? { configuration: { acceptedOutputModes: req.acceptedOutputModes } } : {}),
  } as Parameters<Client['sendMessage']>[0]
}

function toState(raw: Message | Task): RemoteA2aState {
  if (raw.kind !== 'task') return 'message'
  const s = raw.status.state
  return s === 'completed' || s === 'input-required' || s === 'failed' ? s : 'message'
}

export async function executeRemoteA2a(
  client: Client,
  req: RemoteA2aRequest,
): Promise<RemoteA2aResult> {
  let staleResumeDropped = false
  let raw: Message | Task
  try {
    raw = (await client.sendMessage(buildParams(req, true))) as Message | Task
  } catch (e) {
    // Устаревший resume-таск → повторяем как свежий диалог (без taskId). Иначе — пробрасываем.
    if (req.resumeTaskId && isStaleTaskError(e)) {
      staleResumeDropped = true
      raw = (await client.sendMessage(buildParams(req, false))) as Message | Task
    } else {
      throw e
    }
  }

  return {
    text: extractText(raw),
    a2ui: extractA2ui(raw),
    ...(raw.kind === 'task' ? { taskId: raw.id } : {}),
    state: toState(raw),
    staleResumeDropped,
    raw,
  }
}

/** Промежуточное событие прогресса/COT удалённого агента (из A2A `status-update` метаданных). */
export interface RemoteA2aProgressEvent {
  type: 'node' | 'reasoning'
  /** Имя ноды (для `node`) или reasoning-дельта (для `reasoning`). */
  value: string
}

type A2aStreamItem =
  | Message
  | Task
  | { kind: 'status-update'; taskId: string; contextId: string; status: Task['status']; final: boolean; metadata?: Record<string, unknown> }
  | { kind: 'artifact-update'; taskId: string; contextId: string; artifact: NonNullable<Task['artifacts']>[number]; append?: boolean; lastChunk?: boolean }

/** Накапливает финальный `Message | Task` из потока и форвардит node/reasoning через onEvent. */
async function drainStream(
  stream: AsyncGenerator<A2aStreamItem, void, undefined>,
  onEvent: (e: RemoteA2aProgressEvent) => void,
): Promise<Message | Task | undefined> {
  let task: Task | undefined
  let message: Message | undefined
  for await (const ev of stream) {
    if (ev.kind === 'message') {
      message = ev
    } else if (ev.kind === 'task') {
      task = ev
    } else if (ev.kind === 'status-update') {
      const meta = ev.metadata as Record<string, unknown> | undefined
      const node = meta?.['ai37/node']
      const reasoning = meta?.['ai37/reasoning']
      if (typeof node === 'string') onEvent({ type: 'node', value: node })
      if (typeof reasoning === 'string') onEvent({ type: 'reasoning', value: reasoning })
      if (task && ev.taskId === task.id) task = { ...task, status: ev.status }
    } else if (ev.kind === 'artifact-update') {
      if (task && ev.taskId === task.id) {
        const artifacts = [...(task.artifacts ?? [])]
        const idx = artifacts.findIndex((a) => a.artifactId === ev.artifact.artifactId)
        if (idx >= 0 && ev.append) {
          artifacts[idx] = { ...artifacts[idx], parts: [...artifacts[idx].parts, ...ev.artifact.parts] }
        } else if (idx >= 0) {
          artifacts[idx] = ev.artifact
        } else {
          artifacts.push(ev.artifact)
        }
        task = { ...task, artifacts }
      }
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
  let staleResumeDropped = false
  let raw: Message | Task | undefined
  try {
    raw = await drainStream(
      client.sendMessageStream(buildParams(req, true)) as AsyncGenerator<A2aStreamItem, void, undefined>,
      onEvent,
    )
  } catch (e) {
    if (req.resumeTaskId && isStaleTaskError(e)) {
      staleResumeDropped = true
      raw = await drainStream(
        client.sendMessageStream(buildParams(req, false)) as AsyncGenerator<A2aStreamItem, void, undefined>,
        onEvent,
      )
    } else {
      throw e
    }
  }
  if (!raw) {
    throw new Error('executeRemoteA2aStreaming: поток не дал финального Message/Task')
  }

  return {
    text: extractText(raw),
    a2ui: extractA2ui(raw),
    ...(raw.kind === 'task' ? { taskId: raw.id } : {}),
    state: toState(raw),
    staleResumeDropped,
    raw,
  }
}
