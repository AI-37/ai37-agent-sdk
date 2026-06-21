import { describe, it, expect } from 'vitest'
import {
  ChatAttachmentsStoreBackend,
  ProjectAttachmentsStoreBackend,
} from '../src/store-backend/attachments-store-backend'

const CHAT_ATTS = [
  {
    fileId: 'f1',
    sourceName: 'spec.pdf',
    mime: 'application/pdf',
    bytes: 1234,
    sha256: 'aa',
    summary: 'расчёт лифтов жилого дома',
    isLarge: true,
    uploadedAt: '2026',
    expiresAt: '2026',
  },
]
const PROJ_ATTS = [
  {
    fileId: 'f9',
    sourceName: 'plan.docx',
    mime: 'application/vnd.openxmlformats',
    bytes: 9999,
    sha256: 'bb',
    summary: 'план здания',
    isLarge: false,
    uploadedAt: '2026',
  },
]

/** Сервер: маппинг pathname + query → ответ (повторяет REST chat-backend вложений). */
function handler(url: URL): unknown | undefined {
  const p = url.pathname
  const q = url.searchParams.get('q')
  // chat-attachments — требуют contextId
  if (p === '/api/chat-attachments/') {
    return url.searchParams.get('contextId') === 'ctx1' ? { attachments: CHAT_ATTS } : undefined
  }
  if (p === '/api/chat-attachments/f1/content') {
    const offset = url.searchParams.get('offset')
    return { content: offset === '0' ? '# spec\nстрока1' : '# spec\nстрока1\nстрока2' }
  }
  if (p === '/api/chat-attachments/search') {
    return q
      ? { matches: [{ fileId: 'f1', sourceName: 'spec.pdf', line: 5, snippet: '…лифты…' }] }
      : { matches: [] }
  }
  // project-attachments — манифест по projectId, content по fileId
  if (p === '/api/project-attachments/') {
    return url.searchParams.get('projectId') === 'proj1' ? { attachments: PROJ_ATTS } : undefined
  }
  if (p === '/api/project-attachments/f9/content') return { content: '# план\nраздел' }
  return undefined
}

function mockFetch(): typeof fetch {
  return (async (urlStr: string) => {
    const body = handler(new URL(urlStr))
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      json: async () => body ?? {},
    } as Response
  }) as unknown as typeof fetch
}

function chat(contextId: () => string | undefined): ChatAttachmentsStoreBackend {
  return new ChatAttachmentsStoreBackend({
    baseUrl: 'http://chat',
    bearer: () => undefined,
    fetchImpl: mockFetch(),
    contextId,
  })
}
function project(projectId: () => string | undefined): ProjectAttachmentsStoreBackend {
  return new ProjectAttachmentsStoreBackend({
    baseUrl: 'http://chat',
    bearer: () => undefined,
    fetchImpl: mockFetch(),
    projectId,
  })
}

describe('ChatAttachmentsStoreBackend', () => {
  const ctx = () => 'ctx1'

  it('ls("/chat-attachments/") — файлы по fileId', async () => {
    const res = await chat(ctx).ls('/chat-attachments/')
    expect((res.files ?? []).map((f) => f.path)).toEqual(['/chat-attachments/f1'])
  })

  it('read директории — markdown-манифест с source_name/summary', async () => {
    const res = await chat(ctx).read('/chat-attachments/')
    expect(res.content).toContain('spec.pdf')
    expect(res.content).toContain('расчёт лифтов')
    expect(res.content).toContain('большой') // is_large сигнал
  })

  it('read файла с offset/limit → окно (серверная нарезка)', async () => {
    const res = await chat(ctx).read('/chat-attachments/f1', 0, 100)
    expect(res.content).toBe('# spec\nстрока1')
    expect(res.mimeType).toBe('text/markdown')
  })

  it('grep → серверный поиск, путь по fileId', async () => {
    const res = await chat(ctx).grep('лифты', '/chat-attachments/')
    expect(res.matches?.[0].path).toBe('/chat-attachments/f1')
    expect(res.matches?.[0].line).toBe(5)
  })

  it('glob по имени файла', async () => {
    const res = await chat(ctx).glob('spec')
    expect((res.files ?? []).map((f) => f.path)).toEqual(['/chat-attachments/f1'])
  })

  it('нет contextId в ходе → ошибка скоупа', async () => {
    const res = await chat(() => undefined).ls('/chat-attachments/')
    expect(res.error).toBeTruthy()
  })

  it('толерантность к scope-обрезке: якорь не на позиции 0', async () => {
    const res = await chat(ctx).ls('/x/chat-attachments/')
    expect((res.files ?? []).map((f) => f.path)).toEqual(['/chat-attachments/f1'])
  })

  it('write/edit — read-only ошибка', async () => {
    const b = chat(ctx)
    expect((await b.write()).error).toBeTruthy()
    expect((await b.edit()).error).toBeTruthy()
  })
})

describe('ProjectAttachmentsStoreBackend', () => {
  it('ls по projectId', async () => {
    const res = await project(() => 'proj1').ls('/project-attachments/')
    expect((res.files ?? []).map((f) => f.path)).toEqual(['/project-attachments/f9'])
  })

  it('read файла резолвится по fileId без projectId', async () => {
    const res = await project(() => undefined).read('/project-attachments/f9')
    expect(res.content).toContain('план')
  })

  it('нет projectId для манифеста → ошибка скоупа', async () => {
    const res = await project(() => undefined).ls('/project-attachments/')
    expect(res.error).toBeTruthy()
  })
})
