import type { AgentContext, Claims } from '@ai37/agent-sdk'
import type { OutputNegotiation } from './output-modes'

export type { OutputNegotiation }

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
  /**
   * Принимаемые клиентом форматы вывода (content-negotiation, РЕШЕНИЕ 10).
   * Носитель ТОЛЬКО для AG-UI (`forwardedProps.ai37`), где нет нативного A2A-поля.
   * Для A2A носитель — нативный `params.configuration.acceptedOutputModes` (НЕ этот конверт).
   */
  acceptedOutputModes?: string[]
}

/**
 * Декларативный UI-компонент A2UI — УЗЕЛ ДЕРЕВА. Хост уплощает его в плоский список операций
 * (`componentToA2uiOperations`): протокол v0.9 не допускает inline-вложенность, дети — по id-ссылкам.
 */
export interface A2uiComponent {
  component: string
  /** Скалярные props компонента (без слотов детей — они в `children`). */
  props: Record<string, unknown>
  /** Опциональный id узла; если не задан — генерируется при уплощении (корень → `'root'`). */
  id?: string
  /**
   * Каталог surface этого компонента (роутинг A: соседние сообщения из разных каталогов,
   * деградация на base). Имеет смысл только для ВЕРХНЕГО компонента — surface привязан к одному
   * каталогу; `undefined` → первичный согласованный каталог. У детей игнорируется (тот же каталог).
   */
  catalogId?: string
  /**
   * Дочерние компоненты по СЛОТАМ. Ключ — prop, в который уплощатель кладёт id-ссылку:
   *  - одиночный компонент → `ComponentIdSchema` (строка id), напр. `Card.child`;
   *  - массив → `ChildListSchema` (`string[]` id), напр. `Column.children`.
   * Сам prop в `props` задавать НЕ нужно — он вычисляется из этого слота.
   */
  children?: Record<string, A2uiComponent | A2uiComponent[]>
}

export type AgentStatus = 'completed' | 'input-required' | 'failed'

/**
 * Результат frontend-tool, который клиент вернул после рендера UI (HITL, канон AG-UI):
 * пользователь заполнил форму/нажал кнопку → CopilotKit прислал ToolMessage (role=tool).
 * `toolCallId` связывает с исходным TOOL_CALL, `result` — значения (обычно JSON формы).
 */
export interface ToolResult {
  toolCallId: string
  toolName?: string
  result: unknown
}

/** Нормализованный вход (из A2A-сообщения или AG-UI-тела). */
export interface AgentInput {
  text?: string
  data: Record<string, unknown>
  /**
   * Frontend-tools, заявленные клиентом в этом запросе (AG-UI `RunAgentInput.tools`).
   * Агент решает, какой вызвать (программно, без LLM), эмитя `{type:'tool-call'}`.
   */
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>
  /**
   * Результат ранее вызванного frontend-tool, если клиент его вернул на этом ходу
   * (role=tool в messages). Так замыкается HITL-цикл «форма → значения → агент».
   */
  toolResult?: ToolResult
  metadata: Ai37Metadata
  claims?: Claims
  billingOrgId?: string
  taskId: string
  contextId: string
  /** Сырой список принимаемых клиентом форматов текста (media-типы; как пришёл). */
  acceptedOutputModes?: string[]
  /** Каталоги A2UI, заявленные клиентом (`a2uiClientCapabilities.supportedCatalogIds`). */
  supportedCatalogIds?: string[]
  /**
   * Резолвнутая хостом негоциация вывода (две оси, РЕШЕНИЕ 10):
   * `text` — формат текста ЕСЛИ агент его эмитит; `catalogId` — согласованный каталог A2UI
   * или `null`. Хендлер смотрит на неё (`catalogId === null` → не строить A2UI, отдать текст),
   * но финальный enforcement — на хосте: A2UI только при `negotiation.catalogId`, текст — только
   * если агент дал `message` (никаких дефолтов).
   */
  negotiation: OutputNegotiation
  /**
   * Персистентное состояние прошлого хода этого task (HITL/мастер). Host достаёт
   * его из task-store по `taskId` (A2A SDK грузит прошлый Task), handler не хранит
   * состояние сам и не полагается на клиента. undefined на первом ходу.
   */
  taskState?: Record<string, unknown>
}

/** Событие для стрима (AG-UI). */
export type AgentEvent =
  | { type: 'node'; node: string }
  | { type: 'text'; delta: string }
  | { type: 'a2ui'; component: A2uiComponent }
  /**
   * Вызов frontend-tool (HITL, канон AG-UI): host эмитит TOOL_CALL_START/ARGS/END,
   * CopilotKit находит зарегистрированный `useFrontendTool` по `toolName`, рендерит его
   * `renderAndWaitForResponse` и по `respond()` возвращает значения как ToolResult.
   * `toolCallId` — корреляция (host генерирует, если не задан).
   */
  | { type: 'tool-call'; toolName: string; args: Record<string, unknown>; toolCallId?: string }

export interface AgentResult {
  status: AgentStatus
  a2ui?: A2uiComponent[]
  message?: string
  result?: unknown
  /** для input-required — карточка-вопрос пользователю (HITL). */
  followup?: A2uiComponent
  /**
   * Состояние для следующего хода — host персистит его в `task.metadata.state`
   * (multi-turn/HITL). На следующем `message/send` с тем же `taskId` оно вернётся
   * в `AgentInput.taskState`.
   */
  state?: Record<string, unknown>
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
