import { v4 as uuidv4 } from 'uuid'
import type { Client } from '@a2a-js/sdk/client'
import type { Message, Task } from '@a2a-js/sdk'
import type { A2uiComponent, A2uiAction } from '../types'
import { extractText, extractA2ui, isStaleTaskError } from './extract'

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
  if (req.contextRefs?.length) metadata.ai37 = { context_refs: req.contextRefs }
  if (req.action) metadata.a2uiAction = { userAction: req.action }
  if (req.extraMetadata) Object.assign(metadata, req.extraMetadata)

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
