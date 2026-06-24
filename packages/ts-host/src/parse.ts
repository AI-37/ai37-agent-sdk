import type { RequestContext } from '@a2a-js/sdk/server'
import type { Ai37Metadata, A2uiAction } from './types'

export interface ParsedMessage {
  text?: string
  data: Record<string, unknown>
  metadata: Ai37Metadata
  /** A2UI-действие (клик/submit), если оркестратор форварднул его в `message.metadata.a2uiAction`. */
  action?: A2uiAction
  /**
   * W3C trace-context из `message.metadata` (`{ traceparent, tracestate? }`), который оркестратор
   * прокинул через `injectTraceContext`. Host продолжает по нему распределённый трейс (Langfuse v4).
   */
  traceCarrier?: Record<string, string>
}

/** Нормализует A2A-сообщение: текст + data-part + конверт metadata.ai37 + A2UI-действие. */
export function parseA2AMessage(rc: RequestContext): ParsedMessage {
  const parts = rc.userMessage.parts
  const textPart = parts.find((p) => p.kind === 'text')
  const dataPart = parts.find((p) => p.kind === 'data')
  const text = textPart?.kind === 'text' ? textPart.text : undefined
  const data = (dataPart?.kind === 'data' ? dataPart.data : {}) as Record<
    string,
    unknown
  >
  const action = readA2uiAction(rc)
  const traceCarrier = readTraceCarrier(rc)
  return {
    text,
    data,
    metadata: readAi37Metadata(rc, data),
    ...(action ? { action } : {}),
    ...(traceCarrier ? { traceCarrier } : {}),
  }
}

/**
 * W3C trace-context из `message.metadata` (`traceparent`/`tracestate`), который оркестратор положил
 * туда через `injectTraceContext` при исходящем A2A-вызове. undefined, если оркестратор не трассирует.
 */
function readTraceCarrier(rc: RequestContext): Record<string, string> | undefined {
  const md = rc.userMessage.metadata as Record<string, unknown> | undefined
  const traceparent = md?.traceparent
  if (typeof traceparent !== 'string' || traceparent.length === 0) return undefined
  const carrier: Record<string, string> = { traceparent }
  if (typeof md?.tracestate === 'string') carrier.tracestate = md.tracestate
  return carrier
}

/**
 * A2UI-действие из `message.metadata.a2uiAction.userAction` — зеркало AG-UI-пути
 * (`agui.ts readA2uiAction` читает `forwardedProps.a2uiAction.userAction`). Так оркестратор
 * форвардит клик/submit формы вниз конечному агенту по A2A. `name:string` обязателен,
 * `context` → `{}` по умолчанию. Нет действия (обычный текстовый ход) → undefined.
 */
function readA2uiAction(rc: RequestContext): A2uiAction | undefined {
  const ua = (
    rc.userMessage.metadata as { a2uiAction?: { userAction?: unknown } } | undefined
  )?.a2uiAction?.userAction as
    | { name?: unknown; context?: unknown; surfaceId?: unknown; sourceComponentId?: unknown }
    | undefined
  if (!ua || typeof ua.name !== 'string') return undefined
  const action: A2uiAction = {
    name: ua.name,
    context: (ua.context as Record<string, unknown> | undefined) ?? {},
  }
  if (typeof ua.surfaceId === 'string') action.surfaceId = ua.surfaceId
  if (typeof ua.sourceComponentId === 'string') action.sourceComponentId = ua.sourceComponentId
  return action
}

/** metadata.ai37 может прийти в message.metadata, data.ai37 или data.metadata.ai37. */
function readAi37Metadata(
  rc: RequestContext,
  data: Record<string, unknown>,
): Ai37Metadata {
  const fromMsg = (
    rc.userMessage.metadata as Record<string, unknown> | undefined
  )?.ai37 as Ai37Metadata | undefined
  const nested = (data.metadata as Record<string, unknown> | undefined)?.ai37
  const fromData = (data.ai37 ?? nested) as Ai37Metadata | undefined
  return { ...(fromData ?? {}), ...(fromMsg ?? {}) }
}
