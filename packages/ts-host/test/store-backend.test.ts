import { describe, it, expect } from 'vitest'
import { ChatStoreBackend } from '../src/store-backend/chat-store-backend'

const PROJECTS = [{ id: 'p1', slug: 'proj', title: 'Проект А', createdAt: '', updatedAt: '2026' }]
const THREADS_P = [
  { id: '1', contextId: 'th_a', slug: 'chat', title: 'Чат A', projectId: 'p1', createdAt: '', updatedAt: '2026' },
]
const THREADS_FREE = [
  { id: '2', contextId: 'th_b', slug: 'chatx', title: 'Чат B', projectId: null, createdAt: '', updatedAt: '2026' },
]
const MSGS = [
  { role: 'user', content: 'посчитай лифты для жилого дома', a2uiArtifacts: null, createdAt: '' },
  { role: 'assistant', content: 'уточните этажность', a2uiArtifacts: null, createdAt: '' },
]
const GREP = [
  { contextId: 'th_a', threadSlug: 'chat', threadTitle: 'Чат A', projectSlug: 'proj', snippet: '…лифты…' },
]

/** Сервер: маппинг pathname + query → ответ (повторяет контракт chat-backend). */
function handler(url: URL): unknown | undefined {
  const p = url.pathname
  const name = url.searchParams.get('name')
  const content = url.searchParams.get('content')

  if (p === '/api/projects/') {
    if (content) return { matches: GREP }
    if (name) return { projects: PROJECTS.filter((pr) => pr.title.includes(name) || pr.slug.includes(name)) }
    return { projects: PROJECTS }
  }
  if (p === '/api/projects/proj/') return { project: PROJECTS[0] }
  if (p === '/api/projects/proj/threads/') {
    if (content) return { matches: GREP }
    if (name) return { threads: THREADS_P.filter((t) => (t.title ?? '').includes(name)) }
    return { threads: THREADS_P }
  }
  if (p === '/api/projects/proj/threads/chat') return { messages: MSGS }
  if (p === '/api/threads/') {
    if (content) return { matches: [] }
    if (name) return { threads: [] }
    return { threads: THREADS_FREE }
  }
  if (p === '/api/threads/chatx') return { thread: THREADS_FREE[0], messages: MSGS }
  return undefined
}

function mockFetch(): typeof fetch {
  return (async (urlStr: string) => {
    const body = handler(new URL(urlStr))
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404, json: async () => body ?? {} } as Response
  }) as unknown as typeof fetch
}

function makeBackend(): ChatStoreBackend {
  return new ChatStoreBackend({ baseUrl: 'http://chat', bearer: () => undefined, fetchImpl: mockFetch() })
}

describe('ChatStoreBackend', () => {
  it('ls("/projects/") — проекты как директории', async () => {
    const res = await makeBackend().ls('/projects/')
    expect((res.files ?? []).map((f) => f.path)).toEqual(['/projects/proj/'])
  })

  it('ls("/projects/proj/threads/") — чаты проекта', async () => {
    const res = await makeBackend().ls('/projects/proj/threads/')
    expect((res.files ?? []).map((f) => f.path)).toEqual(['/projects/proj/threads/chat'])
  })

  it('ls("/threads/") — чаты вне проектов (?projectId=none)', async () => {
    const res = await makeBackend().ls('/threads/')
    expect((res.files ?? []).map((f) => f.path)).toEqual(['/threads/chatx'])
  })

  it('read чата в проекте — расшифровка', async () => {
    const res = await makeBackend().read('/projects/proj/threads/chat/')
    expect(res.content).toContain('посчитай лифты')
    expect(res.content).toContain('Ассистент')
  })

  it('read чата вне проекта', async () => {
    const res = await makeBackend().read('/threads/chatx/')
    expect(res.content).toContain('посчитай лифты')
  })

  it('glob по имени → серверный ?name=', async () => {
    const res = await makeBackend().glob('Проект', '/projects/')
    expect((res.files ?? []).map((f) => f.path)).toContain('/projects/proj/')
  })

  it('grep по содержимому → серверный ?content= (FTS)', async () => {
    const res = await makeBackend().grep('лифты', '/projects/')
    expect(res.matches?.length).toBe(1)
    expect(res.matches?.[0].path).toBe('/projects/proj/threads/chat')
  })

  it('grep в рамках проекта', async () => {
    const res = await makeBackend().grep('лифты', '/projects/proj/threads/')
    expect(res.matches?.[0].path).toBe('/projects/proj/threads/chat')
  })

  it('толерантность к scope-обрезке: якорь не на позиции 0', async () => {
    // как если бы CompositeBackend оставил /x перед якорем
    const res = await makeBackend().ls('/x/projects/')
    expect((res.files ?? []).map((f) => f.path)).toEqual(['/projects/proj/'])
  })

  it('write/edit — read-only ошибка', async () => {
    const b = makeBackend()
    expect((await b.write()).error).toBeTruthy()
    expect((await b.edit()).error).toBeTruthy()
  })

  it('read с offset/limit режет строки', async () => {
    const res = await makeBackend().read('/projects/proj/threads/chat/', 0, 1)
    expect(res.content).toBe('# Чат chat')
  })
})
