import { TaskState, type Message, type Part, type Task } from '@a2a-js/sdk'
import { TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors'
import type { A2uiComponent, A2uiSnapshot } from '../types'

/**
 * Чистые хелперы разбора ответа удалённого A2A-агента (Message | Task). Без ALS/NestJS/LangChain —
 * переносимы в любой relay. Подняты из chat-backend `remote-agent-registry`.
 */

function partsText(parts: ReadonlyArray<Part> | undefined): string {
  let text = ''
  for (const part of parts ?? []) {
    if (part.content?.$case === 'text') text += part.content.value
  }
  return text
}

/**
 * Результат `sendMessage` (`Message | Task`) — задача? В 1.x у них нет `kind`: у сообщения есть
 * `messageId` и `role`, у задачи — `id` и `status`.
 */
export function isTask(result: Message | Task): result is Task {
  return !('messageId' in result)
}

/**
 * Текст ответа из `Task`. Авторитет — `status.message` терминального снапшота; text-артефакты
 * СУММИРОВАТЬ с ним нельзя.
 *
 * Почему: A2A штатно разрешает стримить ответ дельтами (`artifact-update` + `append: true`), и
 * text-артефакт в этом случае — ЖИВАЯ ПРОЕКЦИЯ того же самого ответа, а не вторая его часть. Такой
 * агент отдаёт один и тот же текст дважды: дельтами в артефакт и снапшотом в `status.message`.
 * Прежняя склейка обоих каналов печатала пользователю ОТВЕТ ДВАЖДЫ. Баг был латентным: у агентов на
 * `createAgentHost` артефакты несут только `kind:'data'` (см. build-task `toTask`), поэтому склейка
 * была безвредна — и ломалась ровно на том, кто пользуется штатным стримингом A2A.
 *
 * Почему авторитет именно `status.message`: прошлые `artifact-update` сервер НЕ реплеит (журнала
 * событий нет), поэтому после reconnect/`tasks/get` доживает только снапшот — стрим невосстановим.
 *
 * Fallback на артефакты — если терминального текста нет вовсе (агент отдал только стрим): тогда
 * артефакты и есть единственный источник.
 */
function collectTaskText(task: Task): string {
  const statusText = partsText(task.status?.message?.parts)
  if (statusText) return statusText

  const chunks: string[] = []
  for (const artifact of task.artifacts ?? []) chunks.push(partsText(artifact.parts))
  return chunks.filter(Boolean).join('\n\n')
}

/** Текст из результата `sendMessage` (Message | Task). */
export function extractText(result: Message | Task): string {
  const text = isTask(result) ? collectTaskText(result) : partsText(result.parts)
  return text.trim()
}

type A2uiItem = A2uiComponent | A2uiSnapshot

/** `a2ui` из data-частей (`{ a2ui: [...] }`); undefined — ни одной такой части нет. */
function partsA2ui(parts: ReadonlyArray<Part> | undefined): A2uiItem[] | undefined {
  let found: A2uiItem[] | undefined
  for (const part of parts ?? []) {
    if (part.content?.$case !== 'data') continue
    const a2ui = (part.content.value as { a2ui?: unknown } | undefined)?.a2ui
    if (Array.isArray(a2ui)) found = [...(found ?? []), ...(a2ui as A2uiItem[])]
  }
  return found
}

/**
 * Форма паузы `input-required`. Мест три, берётся первое, где она есть (они копии друг друга, а не
 * части):
 *  1. `status.message` — data-часть `{ a2ui }` рядом с текстом. Каноничное место (ts-host ≥ 0.2).
 *  2. артефакт `a2ui-<taskId>` — копия для relay 0.3, пока у агента включён `legacyCompat`.
 *  3. `task.metadata.a2ui` — агенты на ts-host 0.1.x и python-host.
 */
function formA2ui(task: Task): A2uiItem[] {
  const fromStatus = partsA2ui(task.status?.message?.parts)
  if (fromStatus) return fromStatus
  const formArtifact = task.artifacts?.find((a) => a.artifactId === `a2ui-${task.id}`)
  const fromArtifact = partsA2ui(formArtifact?.parts)
  if (fromArtifact) return fromArtifact
  const fromMetadata = (task.metadata as { a2ui?: unknown } | undefined)?.a2ui
  return Array.isArray(fromMetadata) ? (fromMetadata as A2uiItem[]) : []
}

/**
 * A2UI из ответа сабагента: результат (`completed`) — из data-частей артефактов, кроме артефакта
 * формы; форма паузы — по `formA2ui`. Элементы — сырые деревья `{component, props, children?,
 * catalogId?}` и/или конверты `A2uiSnapshot` (стабильные id + dataModel, сквозной контракт lookup) —
 * пробрасываются как есть: оркестратор кладёт их в свой `result.a2ui`, host эмитит с теми же id.
 */
export function extractA2ui(result: Message | Task): A2uiItem[] {
  if (!isTask(result)) return []
  const out: A2uiItem[] = []
  for (const artifact of result.artifacts ?? []) {
    if (artifact.artifactId === `a2ui-${result.id}`) continue
    out.push(...(partsA2ui(artifact.parts) ?? []))
  }
  out.push(...formA2ui(result))
  return out
}

/**
 * Ошибка «таск устарел/не найден/в терминальном состоянии» — повод повторить БЕЗ `resumeTaskId`
 * (свежий диалог). Покрывает классы ошибок `@a2a-js/sdk` 1.x (`TaskNotFoundError`; сервер 1.2+
 * отвечает на сообщение в терминальную задачу `UnsupportedOperationError` с «terminal state» в
 * тексте), JSON-RPC-код -32001 и текстовые маркеры (сервер 0.3 отдаёт терминальную задачу как
 * invalid request с тем же текстом).
 */
export function isStaleTaskError(err: unknown): boolean {
  if (err instanceof TaskNotFoundError) return true
  if (err instanceof UnsupportedOperationError && /terminal/i.test(err.message)) return true
  const code = (err as { code?: unknown } | undefined)?.code
  if (code === -32001) return true
  const msg = String((err as { message?: unknown } | undefined)?.message ?? err ?? '').toLowerCase()
  return (
    (msg.includes('task') &&
      (msg.includes('not found') || msg.includes('final') || msg.includes('terminal'))) ||
    msg.includes('cannot be continued')
  )
}

/** Имена состояний задачи в словаре A2A 0.3 — в нём их хранит и сравнивает потребитель relay. */
const STATE_NAMES: Record<number, string> = {
  [TaskState.TASK_STATE_UNSPECIFIED]: 'unknown',
  [TaskState.TASK_STATE_SUBMITTED]: 'submitted',
  [TaskState.TASK_STATE_WORKING]: 'working',
  [TaskState.TASK_STATE_COMPLETED]: 'completed',
  [TaskState.TASK_STATE_FAILED]: 'failed',
  [TaskState.TASK_STATE_CANCELED]: 'canceled',
  [TaskState.TASK_STATE_INPUT_REQUIRED]: 'input-required',
  [TaskState.TASK_STATE_REJECTED]: 'rejected',
  [TaskState.TASK_STATE_AUTH_REQUIRED]: 'auth-required',
}

/**
 * Числовое состояние задачи 1.x (`TaskState.TASK_STATE_INPUT_REQUIRED`) → строка 0.3
 * (`'input-required'`). Например, chat-backend хранит в `RemoteAgentTask.state` строки 0.3 и после
 * перехода на 1.x продолжает их писать. Неизвестное значение → `'unknown'`.
 */
export function taskStateName(state: TaskState | undefined): string {
  return state === undefined ? 'unknown' : (STATE_NAMES[state] ?? 'unknown')
}
