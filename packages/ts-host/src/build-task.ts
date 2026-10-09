import { v4 as uuidv4 } from 'uuid'
import { answerArtifactId } from './a2a-progress'
import { Role, TaskState, type Artifact, type Message, type Task, type TaskStatus } from '@a2a-js/sdk'
import { AgentEvent as SdkEvent, type AgentExecutionEvent } from '@a2a-js/sdk/server'
import { dataPart, textPart } from './parts'
import { filterA2uiByCatalog, type OutputNegotiation } from './output-modes'
import { toA2uiSnapshot } from './a2ui'
import type { A2uiComponent, A2uiSnapshot, AgentResult } from './types'

const now = (): string => new Date().toISOString()

/**
 * Инвариант a2ui-action-owner-by-surface: каждый `input-required` элемент A2UI уезжает КОНВЕРТОМ
 * `A2uiSnapshot` с `surfaceId` — оркестратор строит по нему durable-маппинг «surface →
 * агент-владелец» и маршрутизирует сабмит формы именно её владельцу. Сырое дерево (включая
 * `followup` — путь elevator'а) нормализуется в конверт; дефолт id выводится из taskId: стабилен
 * между шагами ОДНОГО визарда (resume того же таска) и уникален между визардами/повторными
 * запусками в диалоге (новый запуск = новый таск). Заданные агентом id не трогаются (сквозной
 * контракт lookup/in-place replace).
 */
function ensureEnvelopeSurfaceIds(
  items: (A2uiComponent | A2uiSnapshot)[],
  taskId: string,
): A2uiSnapshot[] {
  let minted = 0
  return items.map((item) => {
    const envelope = toA2uiSnapshot(item)
    if (envelope.surfaceId) return envelope
    minted += 1
    return { ...envelope, surfaceId: minted === 1 ? `surf-${taskId}` : `surf-${taskId}-${minted}` }
  })
}

/** Дефолт без негоциации: текст-only (каталог не согласован → A2UI не шлём). */
const TEXT_ONLY: OutputNegotiation = { text: 'text/plain', catalogIds: [], catalogId: null }

/**
 * Сообщение агента: текст и, для паузы `input-required`, форма data-частью `{ a2ui: [...] }`
 * (канонное место формы, см. `toTask`).
 */
export function agentMessage(
  taskId: string,
  contextId: string,
  text: string,
  form?: A2uiSnapshot[],
): Message {
  return {
    messageId: uuidv4(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: form ? [textPart(text), dataPart({ a2ui: form })] : [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function status(state: TaskState, message?: Message): TaskStatus {
  return { state, message, timestamp: now() }
}

/**
 * Id артефакта с копией формы `input-required` для relay 0.3 (см. `toTask`). Стабилен в пределах
 * задачи: следующий ход заменяет копию на месте (или очищает её, см. `finalTaskEvents`), а не копит
 * старые формы рядом с новой.
 */
export function formArtifactId(taskId: string): string {
  return `a2ui-${taskId}`
}

function formArtifact(taskId: string, a2ui: A2uiSnapshot[] | undefined): Artifact {
  return {
    artifactId: formArtifactId(taskId),
    name: 'input-required',
    description: '',
    parts: a2ui ? [dataPart({ a2ui })] : [],
    metadata: undefined,
    extensions: [],
  }
}

/**
 * Заворачивает результат handler'а в A2A-`Task` (типы `@a2a-js/sdk` 1.x). `negotiation` определяет
 * content-negotiation вывода (РЕШЕНИЕ 10, две оси): A2UI (включая HITL-карточку `followup`) — только
 * если каталог согласован (`negotiation.catalogId`); текст для `completed` — только если агент дал
 * `message` (никаких дефолтов). По умолчанию (без negotiation) — text-only.
 *
 * Клиенту 0.3 compat-слой SDK отдаёт ту же задачу в форме 0.3: `kind:'task'`, состояние строкой,
 * data-часть как `{ kind: 'data', data }`.
 *
 * Форма `input-required` по канону A2A — в `status.message`: на паузе агент в этом сообщении говорит,
 * что ему нужно, рядом с текстом идёт data-часть `{ a2ui: [...] }` (так формы кладёт и расширение
 * A2UI для A2A). Артефакт — результат задачи, форме там не место.
 *
 * `legacyFormArtifact` (по умолчанию `true`, хост передаёт свой `legacyCompat`) — та же форма ещё и
 * копией в артефакте `a2ui-<taskId>`. Это для relay 0.3 (ts-host до 0.2.0): в стриме 1.x финал хода
 * после прогресса приходит `status-update`, а старый `drainStream` берёт из него только статус и
 * читает форму из артефактов. Копия уходит вместе с compat 0.3.
 */
export function toTask(
  result: AgentResult,
  taskId: string,
  contextId: string,
  negotiation: OutputNegotiation = TEXT_ONLY,
  opts: { legacyFormArtifact?: boolean } = {},
): Task {
  // A2UI отдаётся только для согласованных каталогов (per-component роутинг); иначе пусто (агент даёт текст).
  // Компоненты остаются СЫРЫМИ деревьями (`{component, props, children?, catalogId?}`) — уплощение в
  // операции делает потребитель через `componentToA2uiOperations` (так оркестратор может пробросить их выше).
  // Конверты `A2uiSnapshot` проходят ЦЕЛИКОМ (сквозной контракт lookup: relay-оркестратор кладёт их
  // в свой result.a2ui, его host эмитит с теми же id); фильтр каталога — по вложенному компоненту.
  const a2ui = (result.a2ui ?? []).filter(
    (item) => filterA2uiByCatalog([toA2uiSnapshot(item).component], negotiation).length > 0,
  )
  const followup =
    result.followup && negotiation.catalogIds.includes(result.followup.catalogId ?? negotiation.catalogId ?? '')
      ? result.followup
      : undefined
  const base = { id: taskId, contextId, history: [] as Message[] }

  if (result.status === 'failed') {
    return {
      ...base,
      status: status(TaskState.TASK_STATE_FAILED, agentMessage(taskId, contextId, result.message ?? 'Ошибка')),
      artifacts: [],
      metadata: undefined,
    }
  }

  if (result.status === 'input-required') {
    // Формы уезжают конвертами с гарантированным surfaceId (см. ensureEnvelopeSurfaceIds).
    const form = ensureEnvelopeSurfaceIds(followup ? [followup] : a2ui, taskId)
    return {
      ...base,
      status: status(
        TaskState.TASK_STATE_INPUT_REQUIRED,
        agentMessage(taskId, contextId, result.message ?? 'Уточните', form),
      ),
      artifacts: (opts.legacyFormArtifact ?? true) ? [formArtifact(taskId, form)] : [],
      metadata: result.state !== undefined ? { state: result.state } : undefined,
    }
  }

  return {
    ...base,
    // Текст — только если агент его дал (компонент-онли каноничен: AG-UI content опционален,
    // A2A не требует текстовый part). Никаких болванок '.Готово'.
    status: status(
      TaskState.TASK_STATE_COMPLETED,
      result.message ? agentMessage(taskId, contextId, result.message) : undefined,
    ),
    metadata: result.state !== undefined ? { state: result.state } : undefined,
    artifacts: [
      {
        artifactId: uuidv4(),
        name: 'result',
        description: '',
        parts: [dataPart({ a2ui, result: result.result })],
        metadata: undefined,
        extensions: [],
      },
    ],
  }
}

/**
 * События финала хода для шины исполнения `@a2a-js/sdk` 1.x.
 *
 * Сервер 1.x не заменяет сохранённую задачу, а сливает с ней новую: `metadata` по ключам, артефакты
 * по `artifactId`. Поэтому то, что прошлый ход оставил, а этот не дал, надо очистить явно, иначе оно
 * доживёт до ответа: форма прошлого шага (артефакт `a2ui-<taskId>` → пустой), стримовый текст
 * прошлого хода (`answer-<taskId>` → пустой, если этот ход текст не стримил: иначе `extractText`
 * показал бы прошлый ответ) и `metadata.state` (→ `null`, читатели считают его отсутствием). На 0.3
 * задача заменялась целиком.
 *
 * `lifecycleStarted` — исполнение уже опубликовало `task` (прогресс). Тогда второй `task` в стриме
 * запрещён, и финал уходит `artifact-update` по каждому артефакту + `status-update` с метаданными.
 * Иначе — один `task`.
 */
export function finalTaskEvents(
  task: Task,
  prior: Task | undefined,
  lifecycleStarted: boolean,
  textStreamed = false,
): AgentExecutionEvent[] {
  const formId = formArtifactId(task.id)
  const artifacts = [...task.artifacts]
  const priorForm = prior?.artifacts?.find((a) => a.artifactId === formId)
  if (priorForm?.parts.length && !artifacts.some((a) => a.artifactId === formId)) {
    artifacts.push(formArtifact(task.id, undefined))
  }
  const answerId = answerArtifactId(task.id)
  const priorAnswer = prior?.artifacts?.find((a) => a.artifactId === answerId)
  if (!textStreamed && priorAnswer?.parts.length && !artifacts.some((a) => a.artifactId === answerId)) {
    artifacts.push({ ...priorAnswer, parts: [] })
  }
  let metadata = task.metadata
  const priorState = prior?.metadata?.state
  if (priorState !== undefined && priorState !== null && metadata?.state === undefined) {
    metadata = { ...metadata, state: null }
  }

  if (!lifecycleStarted) return [SdkEvent.task({ ...task, artifacts, metadata })]
  return [
    ...artifacts.map((artifact) =>
      SdkEvent.artifactUpdate({
        taskId: task.id,
        contextId: task.contextId,
        artifact,
        append: false,
        lastChunk: true,
        metadata: undefined,
      }),
    ),
    SdkEvent.statusUpdate({ taskId: task.id, contextId: task.contextId, status: task.status, metadata }),
  ]
}

/**
 * Снимок хода AG-UI для task-store. На AG-UI `taskId = threadId`: одна задача живёт весь тред, и
 * каждый ход перезаписывает её снимок. Поэтому статус в снимке не бывает терминальным:
 * `completed`/`failed` хода записываются как `TASK_STATE_UNSPECIFIED` (в 0.3 — `unknown`),
 * `input-required` остаётся. Иначе после
 * первого `completed` стор с неизменяемой терминальной задачей (и обработчик `@a2a-js/sdk` 1.2+,
 * который отклоняет сообщения в неё) заморозил бы тред. Так же делает python-host
 * (`agui.py:_save_state` пишет задачу без статуса).
 *
 * Всё остальное как у `toTask`: `metadata.state` для следующего хода, A2UI и артефакт результата.
 */
export function toAguiSnapshot(
  result: AgentResult,
  threadId: string,
  negotiation: OutputNegotiation = TEXT_ONLY,
): Task {
  // Снимок читает только хост (state); копия формы для relay 0.3 тут не нужна.
  const task = toTask(result, threadId, threadId, negotiation, { legacyFormArtifact: false })
  if (task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED) return task
  return { ...task, status: status(TaskState.TASK_STATE_UNSPECIFIED, task.status?.message) }
}
