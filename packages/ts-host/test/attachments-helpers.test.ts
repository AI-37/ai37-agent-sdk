import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../src/ai37-chat-completions', () => ({
  Ai37ChatCompletions: vi.fn().mockImplementation(function (this: object, fields: unknown) {
    return { fields, invoke }
  }),
}))

import {
  attachmentFailureReason,
  attachmentScope,
  createAttachmentReaders,
  extractFromAttachments,
  extractionRequest,
  hasFileRefs,
  messageText,
  projectIdFromRefs,
  readAttachmentContents,
  readStoreWithinBudget,
} from '../src/attachments'
import { Ai37ChatCompletions } from '../src/ai37-chat-completions'

type Route = (url: URL) => unknown

/** fetch, который записывает запросы и отвечает по пути; undefined → 404. */
function fakeFetch(route: Route) {
  const calls: Array<{ url: URL; auth?: string }> = []
  const impl = (async (input: string, init?: { headers?: Record<string, string> }) => {
    const url = new URL(input)
    calls.push({ url, auth: init?.headers?.Authorization })
    const body = route(url)
    return body === undefined
      ? new Response('nope', { status: 404 })
      : new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const SCOPE_INPUT = {
  contextId: 'ctx1',
  contextRefs: ['chat-attachment:c1', 'project:p1', 'chat-attachment:c1', 'unknown:x'],
  contextFiles: [
    {
      ref: 'chat-attachment:c1',
      name: 'договор.docx',
      summary: 'договор поставки',
      scope: 'chat' as const,
    },
    { ref: 'project-attachment:f9', name: 'план.pdf', scope: 'project' as const, isLarge: true },
  ],
}

describe('attachmentScope', () => {
  it('собирает файлы из refs и манифеста без дублей и берёт projectId из project:', () => {
    const scope = attachmentScope(SCOPE_INPUT)
    expect(scope.contextId).toBe('ctx1')
    expect(scope.projectId).toBe('p1')
    expect(scope.files).toEqual([
      {
        ref: 'chat-attachment:c1',
        path: '/chat-attachments/c1',
        name: 'договор.docx',
        summary: 'договор поставки',
        scope: 'chat',
      },
      {
        ref: 'project-attachment:f9',
        path: '/project-attachments/f9',
        name: 'план.pdf',
        scope: 'project',
        isLarge: true,
      },
    ])
  })

  it('без манифеста называет файл его ref', () => {
    const scope = attachmentScope({ contextId: 'c', contextRefs: ['chat-attachment:z'] })
    expect(scope.files).toEqual([
      {
        ref: 'chat-attachment:z',
        path: '/chat-attachments/z',
        name: 'chat-attachment:z',
        scope: 'chat',
      },
    ])
    expect(scope.projectId).toBeUndefined()
  })

  it('ход без файлов даёт пустой список', () => {
    expect(attachmentScope({ contextId: 'c' }).files).toEqual([])
  })
})

describe('hasFileRefs / projectIdFromRefs', () => {
  it('узнаёт файловые и проектные ссылки', () => {
    expect(hasFileRefs(['chat-attachment:a'])).toBe(true)
    expect(hasFileRefs(['project-attachment:a'])).toBe(true)
    expect(hasFileRefs(['project:p'])).toBe(true)
    expect(hasFileRefs(['thread:t'])).toBe(false)
    expect(projectIdFromRefs(['x', 'project:p7'])).toBe('p7')
    expect(projectIdFromRefs(['project:'])).toBeUndefined()
  })
})

describe('createAttachmentReaders', () => {
  const scope = attachmentScope(SCOPE_INPUT)

  it('не читает файл, которого нет в ходе, и даже не ходит в сеть', async () => {
    const { impl, calls } = fakeFetch(() => ({ content: 'чужое' }))
    const readers = createAttachmentReaders({ chatBackendUrl: 'http://cb', scope, fetchImpl: impl })
    const res = await readers.read('chat-attachment:other')
    expect(res.error).toMatch(/нет среди приложенных/)
    expect(calls).toHaveLength(0)
  })

  it('читает окно файла чата с contextId и явным bearer', async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.pathname === '/api/chat-attachments/c1/content' ? { content: 'строка' } : undefined,
    )
    const readers = createAttachmentReaders({
      chatBackendUrl: 'http://cb/',
      scope,
      fetchImpl: impl,
      bearer: () => 'jwt-1',
    })
    const res = await readers.read('chat-attachment:c1', { offset: 10, limit: 5 })
    expect(res.content).toBe('строка')
    expect(calls[0].auth).toBe('Bearer jwt-1')
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      contextId: 'ctx1',
      offset: '10',
      limit: '5',
    })
  })

  it('читает файл проекта без contextId', async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.pathname === '/api/project-attachments/f9/content' ? { content: '# план' } : undefined,
    )
    const readers = createAttachmentReaders({ chatBackendUrl: 'http://cb', scope, fetchImpl: impl })
    expect((await readers.read('project-attachment:f9')).content).toBe('# план')
    expect(calls[0].url.searchParams.get('contextId')).toBeNull()
  })

  it('grep ищет по обеим полкам и оставляет только файлы хода', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.pathname === '/api/chat-attachments/search')
        return {
          matches: [
            { fileId: 'c1', sourceName: 'договор.docx', line: 4, snippet: 'срок   поставки' },
            { fileId: 'stale', sourceName: 'старое.xlsx', line: 1, snippet: 'срок' },
          ],
        }
      if (url.pathname === '/api/project-attachments/search') return undefined
      return undefined
    })
    const readers = createAttachmentReaders({ chatBackendUrl: 'http://cb', scope, fetchImpl: impl })
    const { hits, errors } = await readers.grep('срок')
    expect(hits).toEqual([
      { ref: 'chat-attachment:c1', name: 'договор.docx', line: 4, text: 'срок поставки' },
    ])
    expect(errors).toHaveLength(1)
    expect(calls.map((c) => c.url.searchParams.get('projectId'))).toContain('p1')
  })

  it('readWithinBudget склеивает окна через перевод строки и режет по бюджету', async () => {
    const lines = Array.from({ length: 450 }, (_, i) => `l${i}`)
    const { impl } = fakeFetch((url) => {
      const offset = Number(url.searchParams.get('offset'))
      const limit = Number(url.searchParams.get('limit'))
      return { content: lines.slice(offset, offset + limit).join('\n') }
    })
    const readers = createAttachmentReaders({ chatBackendUrl: 'http://cb', scope, fetchImpl: impl })
    const full = await readers.readWithinBudget('chat-attachment:c1', 1_000_000)
    expect(full).toEqual({ content: lines.join('\n'), truncated: false })
    const cut = await readers.readWithinBudget('chat-attachment:c1', 20)
    expect(cut.truncated).toBe(true)
    expect(cut.content).toHaveLength(20)
  })

  it('readWithinBudget возвращает ошибку бэкенда', async () => {
    const { impl } = fakeFetch(() => undefined)
    const readers = createAttachmentReaders({ chatBackendUrl: 'http://cb', scope, fetchImpl: impl })
    const res = await readers.readWithinBudget('chat-attachment:c1', 100)
    expect(res.error).toMatch(/HTTP 404/)
  })
})

describe('attachmentFailureReason', () => {
  it('различает отказ в доступе, недоступность и прочее', () => {
    expect(attachmentFailureReason('chat-backend /x → HTTP 403')).toBe('access_denied')
    expect(attachmentFailureReason(new Error('HTTP 404'))).toBe('unavailable')
    expect(attachmentFailureReason('ECONNRESET')).toBe('reader_failed')
  })
})

describe('readAttachmentContents', () => {
  it('делит бюджет между файлами, пропускает пустые и собирает отказы', async () => {
    const scope = attachmentScope({
      contextId: 'ctx1',
      contextRefs: [
        'chat-attachment:a',
        'chat-attachment:empty',
        'chat-attachment:gone',
        'chat-attachment:b',
      ],
    })
    const bodies: Record<string, string | undefined> = {
      a: 'x'.repeat(30),
      empty: '   ',
      b: 'y'.repeat(30),
    }
    const { impl } = fakeFetch((url) => {
      const id = url.pathname.split('/')[3]
      return bodies[id] === undefined ? undefined : { content: bodies[id] }
    })
    const readers = createAttachmentReaders({ chatBackendUrl: 'http://cb', scope, fetchImpl: impl })
    const { contents, failures } = await readAttachmentContents(readers, { budgetChars: 40 })
    expect(contents.map((c) => [c.ref, c.content.length, c.truncated])).toEqual([
      ['chat-attachment:a', 30, false],
      ['chat-attachment:b', 10, true],
    ])
    expect(failures).toEqual([
      {
        ref: 'chat-attachment:gone',
        scope: 'chat',
        reason: 'unavailable',
        detail: expect.stringMatching(/404/),
      },
    ])
  })
})

describe('extractFromAttachments', () => {
  const contents = [
    { ref: 'chat-attachment:a', name: 'тз.docx', content: 'толщина 200 мм', truncated: true },
  ]
  const base = {
    llmKey: 'k',
    baseUrl: 'http://llm',
    model: 'm',
    systemPrompt: 'Извлеки',
    query: 'посчитай',
  }

  beforeEach(() => {
    invoke.mockReset()
    vi.mocked(Ai37ChatCompletions).mockClear()
  })

  it('без файлов не зовёт модель', async () => {
    expect(await extractFromAttachments({ ...base, contents: [] })).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('отдаёт модели инструкцию и файлы и возвращает ответ', async () => {
    invoke.mockResolvedValue({ content: 'толщина: 200 мм' })
    const text = await extractFromAttachments({
      ...base,
      contents,
      modelKwargs: { reasoning_effort: 'low' },
    })
    expect(text).toBe('толщина: 200 мм')
    const [messages] = invoke.mock.calls[0]
    expect(messages[0]).toEqual({ role: 'system', content: 'Извлеки' })
    expect(messages[1].content).toContain('<файл имя="тз.docx" обрезан="да">')
    expect(vi.mocked(Ai37ChatCompletions).mock.calls[0][0]).toMatchObject({
      apiKey: 'k',
      temperature: 0,
      modelKwargs: { reasoning_effort: 'low' },
    })
  })

  it('«нет данных» и пустой ответ дают null', async () => {
    invoke.mockResolvedValueOnce({ content: 'Нет данных.' }).mockResolvedValueOnce({ content: '' })
    expect(await extractFromAttachments({ ...base, contents })).toBeNull()
    expect(await extractFromAttachments({ ...base, contents })).toBeNull()
  })

  it('передаёт потолок ответа в модель', async () => {
    invoke.mockResolvedValue({ content: 'ok' })
    await extractFromAttachments({ ...base, contents, maxTokens: 4096 })
    expect(vi.mocked(Ai37ChatCompletions).mock.calls[0][0]).toMatchObject({ maxTokens: 4096 })
  })

  it('без потолка не задаёт maxTokens', async () => {
    invoke.mockResolvedValue({ content: 'ok' })
    await extractFromAttachments({ ...base, contents })
    expect(vi.mocked(Ai37ChatCompletions).mock.calls[0][0]).not.toHaveProperty('maxTokens')
  })

  it('ошибку модели не глотает', async () => {
    invoke.mockRejectedValue(new Error('429'))
    await expect(extractFromAttachments({ ...base, contents })).rejects.toThrow('429')
  })
})

describe('extractionRequest / messageText', () => {
  it('без пометки обрезки для целого файла', () => {
    expect(
      extractionRequest('q', [{ ref: 'r', name: 'a.md', content: 't', truncated: false }]),
    ).toBe(
      'Запрос пользователя: "q".\n\nСодержимое приложенных файлов:\n\n<файл имя="a.md">\nt\n</файл>',
    )
  })

  it('берёт текст из строки, частей и reasoning_content', () => {
    expect(messageText({ content: 'a' })).toBe('a')
    expect(messageText({ content: ['b', { text: 'c' }] })).toBe('bc')
    expect(messageText({ content: '', additional_kwargs: { reasoning_content: 'd' } })).toBe('d')
    expect(messageText(null)).toBe('')
  })
})

describe('readStoreWithinBudget', () => {
  it('читает окнами по пути бэкенда без скоупа хода и режет по бюджету', async () => {
    const lines = Array.from({ length: 450 }, (_, i) => `p${i}`)
    const calls: Array<[string, number | undefined, number | undefined]> = []
    const backend = {
      read: async (path: string, offset?: number, limit?: number) => {
        calls.push([path, offset, limit])
        return { content: lines.slice(offset ?? 0, (offset ?? 0) + (limit ?? 0)).join('\n') }
      },
    }
    expect(await readStoreWithinBudget(backend, '/f9', 1_000_000)).toEqual({
      content: lines.join('\n'),
      truncated: false,
    })
    expect(calls.map((c) => c[1])).toEqual([0, 200, 400])
    expect(calls.every((c) => c[0] === '/f9' && c[2] === 200)).toBe(true)
    const cut = await readStoreWithinBudget(backend, '/f9', 10)
    expect(cut).toMatchObject({ truncated: true })
    expect(cut.content).toHaveLength(10)
  })

  it('возвращает ошибку бэкенда', async () => {
    const backend = { read: () => ({ error: 'chat-backend → HTTP 403' }) }
    expect(await readStoreWithinBudget(backend, '/x', 100)).toEqual({
      content: '',
      truncated: false,
      error: 'chat-backend → HTTP 403',
    })
  })
})
