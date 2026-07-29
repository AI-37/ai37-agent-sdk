import { v4 as uuidv4 } from 'uuid'
import type { Client } from '@a2a-js/sdk/client'
import type { Message, StreamResponse, Task } from '@a2a-js/sdk'
import type { A2uiComponent, A2uiAction, A2uiSnapshot, ContextFile } from '../types'
import { extractText, extractA2ui, isStaleTaskError } from './extract'
import { injectTraceContext } from '../observability/langfuse'
import {
  dataPart,
  isTask,
  partText,
  remoteState,
  textPart,
  userMessage,
} from '../a2a-v1'

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
}

export type RemoteA2aState = 'completed' | 'input-required' | 'failed' | 'message'

export interface RemoteA2aResult {
  text: string
  /** Сырые деревья и/или конверты `A2uiSnapshot` — как отдал сабагент (см. extractA2ui). */
  a2ui: (A2uiComponent | A2uiSnapshot)[]
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
  // Человеко-гейт: форвардим вниз, чтобы сабагент знал, можно ли считать без confirm (машинный вызов).
  if (req.confirmMode) ai37.confirm_mode = req.confirmMode
  if (Object.keys(ai37).length > 0) metadata.ai37 = ai37
  if (req.action) metadata.a2uiAction = { userAction: req.action }
  if (req.extraMetadata) Object.assign(metadata, req.extraMetadata)
  // Langfuse v4 distributed tracing: кладём W3C trace-context активного turn-спана оркестратора
  // (`traceparent`/`tracestate`) в metadata → суб-агент продолжит ТОТ ЖЕ трейс. {} (no-op), если
  // трассировка выключена.
  Object.assign(metadata, injectTraceContext())

  const parts: Message['parts'] = [textPart(req.query)]
  // Структурный вход: A2A data-part рядом с текстом → сервер прочитает как AgentInput.data.
  if (req.data && Object.keys(req.data).length > 0) {
    parts.push(dataPart(req.data))
  }
  const message = userMessage({
    messageId: uuidv4(),
    parts,
    contextId: req.contextId,
    taskId: withResume ? req.resumeTaskId : undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  })
  return {
    tenant: '',
    message,
    configuration: req.acceptedOutputModes
      ? {
          acceptedOutputModes: req.acceptedOutputModes,
          taskPushNotificationConfig: undefined,
          historyLength: undefined,
          returnImmediately: false,
        }
      : undefined,
    metadata: undefined,
  }
}

function toState(raw: Message | Task): RemoteA2aState {
  if (!isTask(raw)) return 'message'
  return remoteState(raw.status?.state) ?? 'message'
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
    ...(isTask(raw) ? { taskId: raw.id } : {}),
    state: toState(raw),
    staleResumeDropped,
    raw,
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

/** Накапливает финальный `Message | Task` из потока и форвардит node/reasoning через onEvent. */
type LegacyStreamItem =
  | (Message & { kind: 'message' })
  | (Task & { kind: 'task' })
  | {
      kind: 'status-update'
      taskId: string
      contextId: string
      status: Task['status']
      metadata?: Record<string, unknown>
    }
  | {
      kind: 'artifact-update'
      taskId: string
      contextId: string
      artifact: NonNullable<Task['artifacts']>[number]
      append?: boolean
      lastChunk?: boolean
    }

function toStreamPayload(
  response: StreamResponse | LegacyStreamItem,
): StreamResponse['payload'] {
  const item = response as unknown as Record<string, unknown>
  if ('payload' in item) return item.payload as StreamResponse['payload']
  const legacy = response as LegacyStreamItem
  if (legacy.kind === 'message') {
    return { $case: 'message', value: legacy }
  }
  if (legacy.kind === 'task') {
    return { $case: 'task', value: legacy }
  }
  if (legacy.kind === 'status-update') {
    return { $case: 'statusUpdate', value: legacy as never }
  }
  return { $case: 'artifactUpdate', value: legacy as never }
}

async function drainStream(
  stream: AsyncGenerator<StreamResponse | LegacyStreamItem, void, undefined>,
  onEvent: (e: RemoteA2aProgressEvent) => void,
): Promise<Message | Task | undefined> {
  let task: Task | undefined
  let message: Message | undefined
  for await (const response of stream) {
    const payload = toStreamPayload(response)
    if (!payload) continue
    if (payload.$case === 'message') {
      message = payload.value
    } else if (payload.$case === 'task') {
      task = payload.value
    } else if (payload.$case === 'statusUpdate') {
      const ev = payload.value
      const meta = ev.metadata as Record<string, unknown> | undefined
      const node = meta?.['ai37/node']
      const reasoning = meta?.['ai37/reasoning']
      const tool = meta?.['ai37/tool']
      if (typeof node === 'string') onEvent({ type: 'node', value: node })
      if (typeof reasoning === 'string') onEvent({ type: 'reasoning', value: reasoning })
      if (tool && typeof tool === 'object') {
        onEvent({ type: 'tool', value: '', tool: tool as RemoteA2aToolCall })
      }
      if (task && ev.taskId === task.id) task = { ...task, status: ev.status }
    } else if (payload.$case === 'artifactUpdate') {
      const ev = payload.value
      // Канон A2A: `append:true` = ИНКРЕМЕНТ (дельта), иначе — ПОЛНЫЙ снапшот (replace). Стрим текста
      // поднимаем ТОЛЬКО при append (part.text = дельта); снапшот-replace как дельту слать нельзя —
      // потребитель их конкатенирует и получит дубли. Финальный текст всё равно соберётся в task и
      // уедет через extractText. data-части (a2ui) не трогаем (уезжают через extractA2ui).
      if (ev.append) {
        for (const part of ev.artifact?.parts ?? []) {
          const text = partText(part)
          if (text) {
            onEvent({ type: 'text', value: text })
          }
        }
      }
      if (task && ev.taskId === task.id && ev.artifact) {
        const artifact = ev.artifact
        const artifacts = [...(task.artifacts ?? [])]
        const idx = artifacts.findIndex((a) => a.artifactId === artifact.artifactId)
        if (idx >= 0 && ev.append) {
          artifacts[idx] = { ...artifacts[idx], parts: [...artifacts[idx].parts, ...artifact.parts] }
        } else if (idx >= 0) {
          artifacts[idx] = artifact
        } else {
          artifacts.push(artifact)
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
      client.sendMessageStream(buildParams(req, true)),
      onEvent,
    )
  } catch (e) {
    if (req.resumeTaskId && isStaleTaskError(e)) {
      staleResumeDropped = true
      raw = await drainStream(
        client.sendMessageStream(buildParams(req, false)),
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
    ...(isTask(raw) ? { taskId: raw.id } : {}),
    state: toState(raw),
    staleResumeDropped,
    raw,
  }
}
