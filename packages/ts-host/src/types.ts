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

/**
 * Манифест-хинт одного приложенного файла. Едет в `metadata.ai37.context_files` РЯДОМ с `context_refs`
 * (12-context-and-state.md): даёт агенту ИМЯ файла (+ краткое summary) без отдельного manifest-round-trip
 * к store, чтобы LLM решала по имени, читать ли тело (`read` по `ref`→path, см. `contextFilePath`). Тела
 * файлов сюда НЕ кладутся — только метаданные. Generic: не привязан к домену конкретного агента.
 */
export interface ContextFile {
  /** Указатель на файл — тот же формат, что элементы `context_refs`: `project-attachment:<id>` | `chat-attachment:<id>`. */
  ref: string
  /** Имя файла (sourceName) — по нему LLM принимает решение, читать ли. */
  name: string
  /** Краткая выжимка содержимого для дисамбигуации (опционально). */
  summary?: string
  /** Откуда файл: durable-полка проекта или эфемерное вложение текущего чата. */
  scope: 'project' | 'chat'
  /** Большой файл — читать грепом/окнами, не целиком. */
  isLarge?: boolean
}

/** Конверт metadata.ai37 (04-a2a-conventions.md). */
export interface Ai37Metadata {
  tenant?: string
  app_id?: string
  channel?: AgentChannel
  thread_id?: string
  session_id?: string
  context_refs?: string[]
  /**
   * Манифест приложенных файлов (имена/summary, БЕЗ тел) — ОПЦИОНАЛЬНЫЙ хинт рядом с `context_refs`,
   * чтобы агент не ходил за манифестом в store. Резолв тел — по-прежнему через store по `ref`.
   * См. `ContextFile` / `renderContextFilesManifest` / `contextFilePath`.
   */
  context_files?: ContextFile[]
  intent?: IntentEnvelope
  trace_id?: string
  /**
   * Принимаемые клиентом форматы вывода (content-negotiation, РЕШЕНИЕ 10).
   * Носитель ТОЛЬКО для AG-UI (`forwardedProps.ai37`), где нет нативного A2A-поля.
   * Для A2A носитель — нативный `params.configuration.acceptedOutputModes` (НЕ этот конверт).
   */
  acceptedOutputModes?: string[]
  /**
   * Постоянная инструкция владельца/партнёра, влияющая на ход диалога (напр. виджет: «считай
   * лифты со скоростью 5 м/с») — ЖЁСТКАЯ политика. Host кладёт её в request-scope
   * (`currentPartnerInstructions`), а общая модель `Ai37ChatCompletions` подмешивает как
   * system-directive абсолютного приоритета в КАЖДЫЙ LLM-вызов хода → работает на всех агентах
   * без их правок. Пусто/undefined (обычно вне widget-канала) → no-op.
   */
  instructions?: string
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
 * A2UI-действие пользователя (канон ACTIVITY_SNAPSHOT, не TOOL_CALL): юзер нажал кнопку/submit
 * A2UI-компонента → CopilotKit (`createA2UIMessageRenderer`) кладёт его в
 * `forwardedProps.a2uiAction.userAction` и дёргает агента. `name` — что нажато
 * (`apply`/`nav:building`/...), `context` — значения полей (для submit) или `{}`.
 */
export interface A2uiAction {
  name: string
  context: Record<string, unknown>
  surfaceId?: string
  sourceComponentId?: string
}

/** Нормализованный вход (из A2A-сообщения или AG-UI-тела). */
export interface AgentInput {
  text?: string
  data: Record<string, unknown>
  /**
   * A2UI-действие пользователя на этом ходу (канон ACTIVITY_SNAPSHOT): клик кнопки/submit
   * формы из `forwardedProps.a2uiAction.userAction`. Handler различает «нажал кнопку/submit»
   * (`input.action`) и обычные данные (`input.data`). undefined на обычном текстовом ходу.
   */
  action?: A2uiAction
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

/**
 * Событие для стрима промежуточного прогресса/COT (AG-UI).
 *
 * Маппинг на AG-UI (`agui.ts`) — переиспользуем НАТИВНЫЙ рендеринг CopilotKit v2:
 *  - `reasoning` → `REASONING_*` → встроенная сворачивающаяся карточка «Thinking…»/«Thought for Ns»;
 *  - `node` (back-compat) → вливается строкой в ту же reasoning-карточку;
 *  - `tool` → `TOOL_CALL_*` → встроенный `DefaultToolCallRenderer` (статус-карточка вызова);
 *  - `text` → `TEXT_MESSAGE_CONTENT`; `a2ui` → `ACTIVITY_SNAPSHOT('a2ui-surface')`.
 *
 * На A2A-пути (`a2a-executor.ts`) `node`/`reasoning` форвардятся вверх как `status-update`
 * с `metadata['ai37/node'|'ai37/reasoning']` (стрим-relay их поднимает в emit оркестратора).
 */
export type AgentEvent =
  | { type: 'node'; node: string }
  | { type: 'text'; delta: string }
  | { type: 'a2ui'; component: A2uiComponent }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool'; phase: 'start' | 'end'; name: string; id?: string; args?: unknown; result?: unknown }

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
