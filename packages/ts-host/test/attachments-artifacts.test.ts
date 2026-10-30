import { describe, expect, it } from 'vitest'
import {
  artifactScope,
  attachmentScope,
  createAttachmentReaders,
  readAttachmentContents,
  type ArtifactScope,
} from '../src/attachments'

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

const meta = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'lift-report',
  name,
  summary: '',
  isLarge: false,
  createdAt: '2026-10-30T00:00:00.000Z',
  files: [],
  ...extra,
})

/** Манифесты корпусов: тред ctx1 и проект p1. */
function listRoute(url: URL) {
  if (url.pathname !== '/api/artifacts') return undefined
  if (url.searchParams.get('contextId') === 'ctx1') {
    return { artifacts: [meta('a1', 'Протокол расчёта лифтов', { summary: 'ГОСТ 22845' })] }
  }
  if (url.searchParams.get('projectId') === 'p1') {
    return { artifacts: [meta('pa1', 'Теплотехнический расчёт', { isLarge: true })] }
  }
  return undefined
}

const TURN = attachmentScope({
  contextId: 'ctx1',
  contextRefs: ['chat-attachment:c1', 'project:p1'],
  contextFiles: [{ ref: 'chat-attachment:c1', name: 'договор.docx', scope: 'chat' as const }],
})

/** Скоуп артефактов без сети: как его вернул бы artifactScope. */
const ARTIFACTS: ArtifactScope = {
  contextId: 'ctx1',
  projectId: 'p1',
  files: [
    {
      ref: 'artifact:a1',
      path: '/artifacts/a1',
      name: 'Протокол расчёта лифтов',
      scope: 'chat',
      kind: 'artifact',
    },
    {
      ref: 'project-artifact:pa1',
      path: '/project-artifacts/pa1',
      name: 'Теплотехнический расчёт',
      scope: 'project',
      kind: 'artifact',
    },
  ],
  errors: [],
}

describe('artifactScope', () => {
  it('загружает артефакты треда и проекта с явным bearer', async () => {
    const { impl, calls } = fakeFetch(listRoute)
    const scope = await artifactScope({
      chatBackendUrl: 'http://cb/',
      contextId: 'ctx1',
      projectId: 'p1',
      bearer: () => 'jwt-1',
      fetchImpl: impl,
    })
    expect(scope).toEqual({
      contextId: 'ctx1',
      projectId: 'p1',
      errors: [],
      files: [
        {
          ref: 'artifact:a1',
          path: '/artifacts/a1',
          name: 'Протокол расчёта лифтов',
          summary: 'ГОСТ 22845',
          scope: 'chat',
          kind: 'artifact',
        },
        {
          ref: 'project-artifact:pa1',
          path: '/project-artifacts/pa1',
          name: 'Теплотехнический расчёт',
          scope: 'project',
          kind: 'artifact',
          isLarge: true,
        },
      ],
    })
    expect(calls.map((c) => c.auth)).toEqual(['Bearer jwt-1', 'Bearer jwt-1'])
  })

  it('без проекта не запрашивает артефакты проекта', async () => {
    const { impl, calls } = fakeFetch(listRoute)
    const scope = await artifactScope({
      chatBackendUrl: 'http://cb',
      contextId: 'ctx1',
      fetchImpl: impl,
    })
    expect(scope.files.map((f) => f.ref)).toEqual(['artifact:a1'])
    expect(calls).toHaveLength(1)
  })

  it('недоступный список даёт ошибку и пустую полку, а не падение', async () => {
    const { impl } = fakeFetch(listRoute)
    const scope = await artifactScope({
      chatBackendUrl: 'http://cb',
      contextId: 'ctx1',
      projectId: 'чужой',
      fetchImpl: impl,
    })
    expect(scope.files.map((f) => f.ref)).toEqual(['artifact:a1'])
    expect(scope.errors).toEqual(['chat-backend /api/artifacts → HTTP 404'])
  })
})

describe('createAttachmentReaders с артефактами', () => {
  it('чужой артефакт не читается и в сеть не ходит', async () => {
    const { impl, calls } = fakeFetch(() => ({ content: 'чужое' }))
    const readers = createAttachmentReaders({
      chatBackendUrl: 'http://cb',
      scope: TURN,
      artifacts: ARTIFACTS,
      fetchImpl: impl,
    })
    for (const ref of ['artifact:foreign', 'project-artifact:foreign', 'artifact:pa1']) {
      expect((await readers.read(ref)).error).toMatch(/нет среди приложенных/)
    }
    expect((await readers.readWithinBudget('project-artifact:a1', 100)).error).toMatch(
      /нет среди приложенных/,
    )
    expect(calls).toHaveLength(0)
  })

  it('добавляет артефакты к файлам хода, не трогая вложения', () => {
    const readers = createAttachmentReaders({
      chatBackendUrl: 'http://cb',
      scope: TURN,
      artifacts: ARTIFACTS,
    })
    expect(readers.scope.files.map((f) => f.ref)).toEqual([
      'chat-attachment:c1',
      'artifact:a1',
      'project-artifact:pa1',
    ])
    expect(readers.file('artifact:a1')?.kind).toBe('artifact')
    expect(readers.file('chat-attachment:c1')?.kind).toBeUndefined()
  })

  it('читает окно своего артефакта по id без корпуса', async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.pathname === '/api/artifacts/pa1/content' ? { content: '# Расчёт' } : undefined,
    )
    const readers = createAttachmentReaders({
      chatBackendUrl: 'http://cb',
      scope: TURN,
      artifacts: ARTIFACTS,
      bearer: () => 'jwt-1',
      fetchImpl: impl,
    })
    const res = await readers.read('project-artifact:pa1', { offset: 0, limit: 50 })
    expect(res.content).toBe('# Расчёт')
    expect(calls[0].auth).toBe('Bearer jwt-1')
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ offset: '0', limit: '50' })
  })

  it('grep ищет по корпусам артефактов и оставляет только загруженные', async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.pathname === '/api/chat-attachments/search') return { matches: [] }
      if (url.pathname !== '/api/artifacts/search') return undefined
      return url.searchParams.get('projectId') === 'p1'
        ? {
            matches: [
              {
                id: 'pa1',
                kind: 'teplo-report',
                name: 'Теплотехнический расчёт',
                snippet: 'R = 3,2',
              },
            ],
          }
        : {
            matches: [
              { id: 'a1', kind: 'lift-report', name: 'Протокол', snippet: 'лифт  на\n8 этажей' },
              { id: 'foreign', kind: 'lift-report', name: 'Чужой', snippet: 'лифт' },
            ],
          }
    })
    const readers = createAttachmentReaders({
      chatBackendUrl: 'http://cb',
      scope: TURN,
      artifacts: ARTIFACTS,
      fetchImpl: impl,
    })
    const { hits, errors } = await readers.grep('лифт')
    expect(errors).toEqual([])
    expect(hits).toEqual([
      { ref: 'artifact:a1', name: 'Протокол расчёта лифтов', line: 1, text: 'лифт на 8 этажей' },
      { ref: 'project-artifact:pa1', name: 'Теплотехнический расчёт', line: 1, text: 'R = 3,2' },
    ])
    const artifactSearches = calls.filter((c) => c.url.pathname === '/api/artifacts/search')
    expect(artifactSearches.map((c) => Object.fromEntries(c.url.searchParams))).toEqual([
      { contextId: 'ctx1', q: 'лифт' },
      { projectId: 'p1', q: 'лифт' },
    ])
  })

  it('readAttachmentContents читает артефакты наравне с вложениями', async () => {
    const { impl } = fakeFetch((url) => {
      if (url.pathname === '/api/chat-attachments/c1/content') return { content: 'договор' }
      if (url.pathname === '/api/artifacts/a1/content') return { content: 'протокол' }
      if (url.pathname === '/api/artifacts/pa1/content') return { content: '' }
      return undefined
    })
    const readers = createAttachmentReaders({
      chatBackendUrl: 'http://cb',
      scope: TURN,
      artifacts: ARTIFACTS,
      fetchImpl: impl,
    })
    const { contents, failures } = await readAttachmentContents(readers)
    expect(contents.map((c) => [c.ref, c.content])).toEqual([
      ['chat-attachment:c1', 'договор'],
      ['artifact:a1', 'протокол'],
    ])
    expect(failures).toEqual([])
  })
})
