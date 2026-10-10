import { Writable } from 'node:stream'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { REDACTED, agentLoggerOptions, redactForLog, redactSecretsInText } from '../src'
import { InMemoryBillingClient, fixtures, makeTestContext } from '../src/testing'

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl'
const LLM_KEY = 'sk-AbCdEfGhIjKlMnOpQrStUv'

describe('redactSecretsInText', () => {
  it.each([
    ['JWT', `token=${JWT} tail`, `token=${REDACTED} tail`],
    ['Bearer', `Authorization: Bearer abc.def-123`, `Authorization: Bearer ${REDACTED}`],
    ['ключ sk-', `key ${LLM_KEY}.`, `key ${REDACTED}.`],
    [
      'URL с id_token_hint',
      `/end-session/?id_token_hint=${JWT}`,
      `/end-session/?id_token_hint=${REDACTED}`,
    ],
  ])('%s', (_label, input, expected) => {
    expect(redactSecretsInText(input)).toBe(expected)
  })

  it('обычный текст и короткие sk- не трогает', () => {
    const text = 'task sk-1 done; eyJ alone; skill=calc'
    expect(redactSecretsInText(text)).toBe(text)
  })
})

describe('redactForLog', () => {
  it('маскирует строку по имени поля на любой глубине, числа оставляет', () => {
    const input = {
      password: 'p@ss',
      nested: {
        apiKey: 'abc',
        'x-api-key': 'def',
        deeper: { clientSecret: 'ghi', llm_key: 'jkl' },
      },
      headers: { Authorization: 'Basic Zm9v', cookie: 'sid=1' },
      remainingTotalTokens: 15516085,
      maxTokens: 512,
      taskId: 't1',
    }
    expect(redactForLog(input)).toEqual({
      password: REDACTED,
      nested: {
        apiKey: REDACTED,
        'x-api-key': REDACTED,
        deeper: { clientSecret: REDACTED, llm_key: REDACTED },
      },
      headers: { Authorization: REDACTED, cookie: REDACTED },
      remainingTotalTokens: 15516085,
      maxTokens: 512,
      taskId: 't1',
    })
  })

  it('вырезает секреты по виду из значений любых полей и массивов', () => {
    expect(redactForLog({ note: `got ${LLM_KEY}`, list: [JWT, 'ok'] })).toEqual({
      note: `got ${REDACTED}`,
      list: [REDACTED, 'ok'],
    })
  })

  it('не меняет исходник, выдерживает циклы и глубину', () => {
    const input: Record<string, unknown> = { token: 'x' }
    input.self = input
    let deep: Record<string, unknown> = { leaf: 'v' }
    for (let i = 0; i < 20; i += 1) deep = { child: deep }
    const out = redactForLog({ input, deep }) as {
      input: Record<string, unknown>
    }
    expect(input.token).toBe('x')
    expect(out.input.self).toBe('[Circular]')
    expect(JSON.stringify(out)).toContain('[MaxDepth]')
  })

  it('Error: message и stack без секретов, Date и буферы как есть', () => {
    const err = Object.assign(new Error(`401 for Bearer ${JWT}`), {
      apiKey: 'k',
    })
    const date = new Date(0)
    const out = redactForLog({ err, date, bytes: Uint8Array.of(1) }) as Record<string, any>
    expect(out.err).toBeInstanceOf(Error)
    expect(out.err.message).toBe(`401 for Bearer ${REDACTED}`)
    expect(out.err.stack).not.toContain(JWT)
    expect(out.err.apiKey).toBe(REDACTED)
    expect(out.date).toBe(date)
    expect(out.bytes).toBeInstanceOf(Uint8Array)
  })

  it('AgentContext сериализуется выжимкой через toJSON', async () => {
    const ctx = await makeTestContext({
      claims: {
        iss: 'i',
        aud: 'a',
        sub: 'u1',
        exp: 0,
        iat: 0,
        org_id: 'o1',
        billing_org_id: 'b1',
      },
      billing: new InMemoryBillingClient({
        runtimeState: fixtures.runtimeState.active(),
      }),
    })
    await ctx.assertExecutionAllowed()
    const line = JSON.stringify(redactForLog({ state: { ctx } }))
    expect(line).not.toContain('test.token')
    expect(line).not.toContain('sk-test-llm')
    expect(line).toContain('"hasLlmKey":true')
  })
})

describe('agentLoggerOptions + pino', () => {
  function capture(name = 'agent') {
    const chunks: string[] = []
    const sink = new Writable({
      write(chunk, _enc, done) {
        chunks.push(String(chunk))
        done()
      },
    })
    const log = pino(agentLoggerOptions({ level: 'info', name }), sink)
    return { log, line: () => chunks.join('') }
  }

  it('объект записи, текст сообщения и err без секретов; тип ошибки сохраняется', () => {
    const { log, line } = capture()
    log.info(
      {
        state: { ctx: { rawToken: JWT, cachedState: { llmKey: LLM_KEY } } },
        err: new TypeError(`bad ${LLM_KEY}`),
      },
      `request with Bearer ${JWT}`,
    )
    const out = line()
    expect(out).not.toContain(JWT)
    expect(out).not.toContain(LLM_KEY)
    const parsed = JSON.parse(out)
    expect(parsed.err).toMatchObject({
      type: 'TypeError',
      message: `bad ${REDACTED}`,
    })
    expect(parsed.name).toBe('agent')
    expect(parsed.level).toBe(30)
    expect(parsed.msg).toBe(`request with Bearer ${REDACTED}`)
  })

  it('обычная запись проходит без изменений', () => {
    const { log, line } = capture()
    log.info({ taskId: 't1', status: 'completed', inputTokens: 10 }, 'handler.run OUT')
    expect(JSON.parse(line())).toMatchObject({
      taskId: 't1',
      status: 'completed',
      inputTokens: 10,
      msg: 'handler.run OUT',
    })
  })
})
