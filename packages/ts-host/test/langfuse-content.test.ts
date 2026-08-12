import { afterEach, describe, expect, it } from 'vitest'
import {
  TRACE_SCHEMA_VERSION,
  isLangfuseContentCaptured,
  langfuseContentMask,
  traceMetadata,
  turnOutputPayload,
  turnTracePayload,
} from '../src'

/**
 * Содержимое хода в трассировку не уходит. Трейс привязан к `userId`/`sessionId`, то есть
 * содержимое становится профилируемым по конкретному человеку и уезжает туда, где стоит Langfuse —
 * в том числе во внешний SaaS. Безопасный дефолт общего хоста: структура и тайминги — да,
 * содержимое — только по явному включению.
 */

const SECRET = 'Подготовь политику для ООО «Ромашка», директор Иванов И.И.'
const DOCUMENT = '# Приказ\n\nНазначить Петрову М.С. ответственной.'

afterEach(() => {
  delete process.env.LANGFUSE_CAPTURE_CONTENT
})

describe('дефолт — содержимое не захватывается', () => {
  it('захват выключен, пока его явно не включили', () => {
    expect(isLangfuseContentCaptured()).toBe(false)
  })

  it('пустое значение переменной не включает захват', () => {
    process.env.LANGFUSE_CAPTURE_CONTENT = ''
    expect(isLangfuseContentCaptured()).toBe(false)
  })

  it.each(['true', '1', 'yes', 'on'])('включается значением %s', (v) => {
    process.env.LANGFUSE_CAPTURE_CONTENT = v
    expect(isLangfuseContentCaptured()).toBe(true)
  })
})

describe('вход хода', () => {
  it('вместо текста пользователя — только его длина', () => {
    const payload = turnTracePayload(SECRET, false)
    expect(JSON.stringify(payload)).not.toContain('Ромашка')
    expect(JSON.stringify(payload)).not.toContain('Иванов')
    expect(payload.input).toEqual({ textLen: SECRET.length })
  })

  it('при явном включении текст пишется как есть', () => {
    expect(turnTracePayload(SECRET, true).input).toEqual({ text: SECRET })
  })

  it('отсутствующий текст не добавляет поле input', () => {
    expect(turnTracePayload(undefined, false)).toEqual({})
    expect(turnTracePayload(undefined, true)).toEqual({})
  })
})

describe('результат хода', () => {
  it('готовый документ в трейс не попадает', () => {
    const payload = turnOutputPayload(
      { status: 'completed', message: DOCUMENT },
      false,
    )
    expect(JSON.stringify(payload)).not.toContain('Петров')
    expect(payload).toEqual({
      status: 'completed',
      messageLen: DOCUMENT.length,
    })
  })

  it('статус сохраняется — без него трейс бесполезен', () => {
    expect(turnOutputPayload({ status: 'failed' }, false)).toEqual({
      status: 'failed',
    })
  })

  it('при явном включении результат пишется как есть', () => {
    const output = { status: 'completed', message: DOCUMENT }
    expect(turnOutputPayload(output, true)).toEqual(output)
  })

  it('отсутствующий результат остаётся отсутствующим', () => {
    expect(turnOutputPayload(undefined, false)).toBeUndefined()
  })
})

/**
 * Маска процессора — единственное, что закрывает спаны, которые строит не хост, а
 * `@langfuse/langchain` (промпты и ответы модели). Langfuse применяет её к input, output И metadata,
 * поэтому служебную метаданную приходится пропускать явно — иначе трейс лишается turnId, статуса,
 * канала и тенанта, то есть всего, ради чего он нужен.
 */
describe('маска процессора', () => {
  it('содержимое заменяется меткой с объёмом', () => {
    expect(langfuseContentMask({ data: SECRET })).toEqual({
      redacted: true,
      chars: SECRET.length,
    })
  })

  it('объект-промпт тоже редактируется', () => {
    const masked = langfuseContentMask({
      data: { messages: [{ role: 'user', content: SECRET }] },
    })
    expect(JSON.stringify(masked)).not.toContain('Ромашка')
    expect(masked).toHaveProperty('redacted', true)
  })

  it('служебная метаданная хода проходит как есть — объектом', () => {
    const meta = traceMetadata('turn', {
      turnId: 'task-1',
      sessionId: 'ctx-1',
      status: 'completed',
      service: 'pdai-doc-gen-agent',
    })
    expect(langfuseContentMask({ data: meta })).toBe(meta)
  })

  it('служебная метаданная проходит и в сериализованном виде', () => {
    const serialized = JSON.stringify(
      traceMetadata('turn', { turnId: 't', sessionId: 's' }),
    )
    expect(serialized).toContain(`"schemaVersion":"${TRACE_SCHEMA_VERSION}"`)
    expect(langfuseContentMask({ data: serialized })).toBe(serialized)
  })

  it('null и undefined не превращаются в метку', () => {
    expect(langfuseContentMask({ data: null })).toBeNull()
    expect(langfuseContentMask({ data: undefined })).toBeUndefined()
  })
})
