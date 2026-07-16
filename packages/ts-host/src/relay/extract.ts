import type { Message, Task } from '@a2a-js/sdk'
import type { A2uiComponent, A2uiSnapshot } from '../types'

/**
 * Чистые хелперы разбора ответа удалённого A2A-агента (Message | Task). Без ALS/NestJS/LangChain —
 * переносимы в любой relay. Подняты из chat-backend `remote-agent-registry`.
 */

type TextPart = { kind: string; text?: string }

function partsText(parts: ReadonlyArray<TextPart>): string {
  return parts
    .filter((p) => p.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
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
  const statusText = task.status.message?.parts
    ? partsText(task.status.message.parts as TextPart[])
    : ''
  if (statusText) return statusText

  const chunks: string[] = []
  for (const artifact of task.artifacts ?? []) chunks.push(partsText(artifact.parts as TextPart[]))
  return chunks.filter(Boolean).join('\n\n')
}

/** Текст из результата `sendMessage` (Message | Task). */
export function extractText(result: Message | Task): string {
  const text = result.kind === 'task' ? collectTaskText(result) : partsText(result.parts as TextPart[])
  return text.trim()
}

/**
 * A2UI из ответа сабагента: `completed` → `artifact.parts[data].data.a2ui`,
 * `input-required` (форма) → `task.metadata.a2ui`. Элементы — сырые деревья
 * `{component, props, children?, catalogId?}` и/или конверты `A2uiSnapshot`
 * (стабильные id + dataModel, сквозной контракт lookup) — пробрасываются как
 * есть: оркестратор кладёт их в свой `result.a2ui`, host эмитит с теми же id.
 */
export function extractA2ui(result: Message | Task): (A2uiComponent | A2uiSnapshot)[] {
  if (result.kind !== 'task') return []
  const out: (A2uiComponent | A2uiSnapshot)[] = []
  for (const artifact of result.artifacts ?? []) {
    for (const part of artifact.parts) {
      if (part.kind === 'data') {
        const a2ui = (part.data as { a2ui?: unknown } | undefined)?.a2ui
        if (Array.isArray(a2ui)) out.push(...(a2ui as (A2uiComponent | A2uiSnapshot)[]))
      }
    }
  }
  const metaA2ui = (result.metadata as { a2ui?: unknown } | undefined)?.a2ui
  if (Array.isArray(metaA2ui)) out.push(...(metaA2ui as (A2uiComponent | A2uiSnapshot)[]))
  return out
}

/**
 * Ошибка «таск устарел/не найден/в терминальном состоянии» — повод повторить БЕЗ `resumeTaskId`
 * (свежий диалог). Покрывает A2A `TaskNotFoundError` (-32001) и текстовые маркеры.
 */
export function isStaleTaskError(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code
  if (code === -32001) return true
  const msg = String((err as { message?: unknown } | undefined)?.message ?? err ?? '').toLowerCase()
  return (
    (msg.includes('task') &&
      (msg.includes('not found') || msg.includes('final') || msg.includes('terminal'))) ||
    msg.includes('cannot be continued')
  )
}
