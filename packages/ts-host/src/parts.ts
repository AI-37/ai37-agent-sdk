import type { Part } from '@a2a-js/sdk'

/** Текстовая часть сообщения A2A 1.x (`content.$case = 'text'`); в 0.3 это `{ kind: 'text', text }`. */
export function textPart(text: string): Part {
  return { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: '' }
}

/** Data-часть A2A 1.x (`content.$case = 'data'`); в 0.3 это `{ kind: 'data', data }`. */
export function dataPart(data: unknown): Part {
  return { content: { $case: 'data', value: data }, metadata: undefined, filename: '', mediaType: '' }
}
