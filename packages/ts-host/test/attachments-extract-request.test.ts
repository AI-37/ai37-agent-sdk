import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractFromAttachments } from '../src/attachments'

/**
 * Без мока Ai37ChatCompletions: проверяем тело запроса, которое уходит в LiteLLM. Именно здесь
 * `modelKwargs.max_tokens` терялся — LangChain собирает параметры запроса сам и перезаписывает
 * поле своим `maxTokens`, поэтому потолок задаётся отдельной опцией.
 */
describe('extractFromAttachments: запрос в LiteLLM', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubLiteLlm() {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? '{}'))
        return Response.json({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'm',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'толщина: 200 мм' },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      }),
    )
    return bodies
  }

  const base = {
    llmKey: 'k',
    baseUrl: 'http://litellm.test/v1',
    model: 'm',
    systemPrompt: 'Извлеки',
    query: 'посчитай',
    contents: [
      { ref: 'chat-attachment:a', name: 'тз.docx', content: 'толщина 200 мм', truncated: false },
    ],
  }

  it('потолок ответа доходит до тела запроса вместе с modelKwargs', async () => {
    const bodies = stubLiteLlm()
    const text = await extractFromAttachments({
      ...base,
      maxTokens: 4096,
      modelKwargs: { reasoning_effort: 'low' },
    })
    expect(text).toBe('толщина: 200 мм')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({
      model: 'm',
      max_tokens: 4096,
      temperature: 0,
      reasoning_effort: 'low',
    })
    expect(bodies[0].messages).toEqual([
      { role: 'system', content: 'Извлеки' },
      { role: 'user', content: expect.stringContaining('<файл имя="тз.docx">') },
    ])
  })

  it('без потолка max_tokens в запрос не попадает', async () => {
    const bodies = stubLiteLlm()
    await extractFromAttachments(base)
    expect(bodies[0]).not.toHaveProperty('max_tokens')
  })
})
