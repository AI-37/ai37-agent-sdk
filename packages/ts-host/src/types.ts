import type { AgentContext, Claims } from '@ai37/agent-sdk'

/**
 * Контракт host'а. Host не знает про «ноды» агента — он знает про `AgentHandler`:
 * принять нормализованный вход + verified `AgentContext` → вернуть `AgentResult`.
 * Вся когниция (intent/work/critic/respond) — внутри handler'а конкретного агента.
 */

export type AgentChannel = 'web' | 'widget' | 'revit'

export interface IntentEnvelope {
  skill: string
  params?: Record<string, unknown>
}

/** Конверт metadata.ai37 (04-a2a-conventions.md). */
export interface Ai37Metadata {
  tenant?: string
  app_id?: string
  channel?: AgentChannel
  thread_id?: string
  session_id?: string
  context_refs?: string[]
  intent?: IntentEnvelope
  trace_id?: string
}

/** Декларативный UI-компонент (ai37-a2ui-catalog). */
export interface A2uiComponent {
  component: string
  props: Record<string, unknown>
}

export type AgentStatus = 'completed' | 'input-required' | 'failed'

/** Нормализованный вход (из A2A-сообщения или AG-UI-тела). */
export interface AgentInput {
  text?: string
  data: Record<string, unknown>
  metadata: Ai37Metadata
  claims?: Claims
  billingOrgId?: string
  taskId: string
  contextId: string
}

/** Событие для стрима (AG-UI). */
export type AgentEvent =
  | { type: 'node'; node: string }
  | { type: 'text'; delta: string }
  | { type: 'a2ui'; component: A2uiComponent }

export interface AgentResult {
  status: AgentStatus
  a2ui?: A2uiComponent[]
  message?: string
  result?: unknown
  /** для input-required — карточка-вопрос пользователю (HITL). */
  followup?: A2uiComponent
}

export interface AgentRequest {
  input: AgentInput
  /** verified context из @ai37/agent-sdk (claims + billing). undefined при auth.required=false. */
  ctx?: AgentContext
  /** стрим промежуточных событий (AG-UI). Для A2A non-stream — no-op. */
  emit: (e: AgentEvent) => void
}

/** Когниция агента. Реализуется в каждом агенте; host её вызывает. */
export interface AgentHandler {
  run(req: AgentRequest): Promise<AgentResult>
}
