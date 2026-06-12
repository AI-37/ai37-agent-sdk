import type { RequestContext } from '@a2a-js/sdk/server'
import type { Ai37Metadata } from './types'

export interface ParsedMessage {
  text?: string
  data: Record<string, unknown>
  metadata: Ai37Metadata
}

/** Нормализует A2A-сообщение: текст + data-part + конверт metadata.ai37. */
export function parseA2AMessage(rc: RequestContext): ParsedMessage {
  const parts = rc.userMessage.parts
  const textPart = parts.find((p) => p.kind === 'text')
  const dataPart = parts.find((p) => p.kind === 'data')
  const text = textPart?.kind === 'text' ? textPart.text : undefined
  const data = (dataPart?.kind === 'data' ? dataPart.data : {}) as Record<
    string,
    unknown
  >
  return { text, data, metadata: readAi37Metadata(rc, data) }
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
