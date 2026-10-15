import { describe, it, expect } from 'vitest'
import { HumanMessage } from '@langchain/core/messages'
import {
  AI37_LLM_MAX_RETRIES,
  AI37_LLM_TIMEOUT_MS,
  Ai37ChatCompletions,
} from '../src/ai37-chat-completions'

const OK_BODY = {
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ок' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

/** Подставной fetch для OpenAI SDK: отвечает кодами из `statuses` по очереди, дальше — 200. */
function scriptedFetch(statuses: number[], headers: Record<string, string> = {}) {
  let calls = 0
  const fetch = (): Promise<Response> => {
    const status = statuses[calls++] ?? 200
    const body = status === 200 ? OK_BODY : { error: { message: `status ${status}`, type: 'x' } }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    )
  }
  return { fetch, calls: () => calls }
}

function model(fetch: () => Promise<Response>, fields: Record<string, unknown> = {}) {
  return new Ai37ChatCompletions({
    model: 'm',
    apiKey: 'sk-test',
    configuration: { baseURL: 'http://litellm.test/v1', fetch },
    ...fields,
  })
}

// `AsyncCaller.maxRetries` — protected: читаем как есть, это и есть число повторов LangChain.
const maxRetriesOf = (m: Ai37ChatCompletions) => (m.caller as unknown as { maxRetries: number }).maxRetries

describe('Ai37ChatCompletions — повторы и таймаут', () => {
  it('по умолчанию одна попытка сверху и 180 с на попытку', () => {
    const m = model(scriptedFetch([]).fetch)
    expect(m.timeout).toBe(AI37_LLM_TIMEOUT_MS)
    expect(AI37_LLM_TIMEOUT_MS).toBe(180_000)
    expect(maxRetriesOf(m)).toBe(AI37_LLM_MAX_RETRIES)
    expect(AI37_LLM_MAX_RETRIES).toBe(1)
  })

  it('429 не повторяется: шлюз его уже выждал', async () => {
    // Retry-After ≤ 60 с новый LangChain сам бы выждал и повторил — проверяем, что не повторяет.
    const f = scriptedFetch([429, 429], { 'retry-after': '1' })
    await expect(model(f.fetch).invoke([new HumanMessage('hi')])).rejects.toMatchObject({ status: 429 })
    expect(f.calls()).toBe(1)
  })

  it('5xx повторяется один раз', async () => {
    const f = scriptedFetch([500])
    const res = await model(f.fetch).invoke([new HumanMessage('hi')])
    expect(res.content).toBe('ок')
    expect(f.calls()).toBe(2)
  }, 15_000)

  it('5xx дважды подряд — ошибка после второй попытки', async () => {
    const f = scriptedFetch([500, 500, 500])
    await expect(model(f.fetch).invoke([new HumanMessage('hi')])).rejects.toMatchObject({ status: 500 })
    expect(f.calls()).toBe(2)
  }, 15_000)

  it('4xx (кроме 429) не повторяется — стандартный обработчик LangChain', async () => {
    const f = scriptedFetch([400])
    await expect(model(f.fetch).invoke([new HumanMessage('hi')])).rejects.toMatchObject({ status: 400 })
    expect(f.calls()).toBe(1)
  })

  it('явные maxRetries / timeout / onFailedAttempt побеждают дефолты', async () => {
    const seen: number[] = []
    const f = scriptedFetch([429, 429])
    const m = model(f.fetch, {
      maxRetries: 2,
      timeout: 5_000,
      onFailedAttempt: (e: { status?: number }) => {
        seen.push(e.status ?? 0)
      },
    })
    expect(m.timeout).toBe(5_000)
    expect(maxRetriesOf(m)).toBe(2)
    const res = await m.invoke([new HumanMessage('hi')])
    expect(res.content).toBe('ок')
    expect(seen).toEqual([429, 429])
    expect(f.calls()).toBe(3)
  }, 15_000)
})
