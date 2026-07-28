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

// Бэкенд MOUNT-RELATIVE (контракт CompositeBackend): composite срезает префикс маунта на входе
// и добавляет его к путям результатов на выходе. Поэтому бэкенд видит `/` и `/<fileId>`,
// а внешние пути (`/chat-attachments/f1`) существуют только снаружи composite.
describe('ChatAttachmentsStoreBackend', () => {
  const ctx = () => 'ctx1'

  it('ls("/") — файлы по fileId, пути относительные', async () => {
    const res = await chat(ctx).ls('/')
    expect((res.files ?? []).map((f) => f.path)).toEqual(['/f1'])
  })

  it('read("/") — markdown-манифест с source_name/summary', async () => {
    const res = await chat(ctx).read('/')
    expect(res.content).toContain('spec.pdf')
    expect(res.content).toContain('расчёт лифтов')
    expect(res.content).toContain('большой') // is_large сигнал
  })

  it('read файла с offset/limit → окно (серверная нарезка)', async () => {
    const res = await chat(ctx).read('/f1', 0, 100)
    expect(res.content).toBe('# spec\nстрока1')
    expect(res.mimeType).toBe('text/markdown')
  })

  it('grep → серверный поиск, относительный путь по fileId', async () => {
    const res = await chat(ctx).grep('лифты', '/')
    expect(res.matches?.[0].path).toBe('/f1')
    expect(res.matches?.[0].line).toBe(5)
  })

  it('glob по имени файла', async () => {
    const res = await chat(ctx).glob('spec')
    expect((res.files ?? []).map((f) => f.path)).toEqual(['/f1'])
  })

  it('нет contextId в ходе → ошибка скоупа', async () => {
    const res = await chat(() => undefined).ls('/')
    expect(res.error).toBeTruthy()
  })

  it('write/edit — read-only ошибка', async () => {
    const b = chat(ctx)
    expect((await b.write()).error).toBeTruthy()
    expect((await b.edit()).error).toBeTruthy()
  })

  // BREAKING: якорная форма пути standalone больше не поддерживается — бэкенд не знает
  // своего маунта. `/chat-attachments/f1` = два сегмента → «Неизвестный путь».
  it('якорный путь standalone → ошибка (breaking, mount-relative контракт)', async () => {
    const res = await chat(ctx).read('/chat-attachments/f1')
    expect(res.error).toBeTruthy()
  })

  it('путь глубже одного сегмента → ошибка, не ложный fileId', async () => {
    const res = await chat(ctx).read('/foo/bar')
    expect(res.error).toBeTruthy()
  })
})

describe('ProjectAttachmentsStoreBackend', () => {
  it('ls("/") по projectId — относительные пути', async () => {
    const res = await project(() => 'proj1').ls('/')
    expect((res.files ?? []).map((f) => f.path)).toEqual(['/f9'])
  })

  it('read файла резолвится по fileId без projectId', async () => {
    const res = await project(() => undefined).read('/f9')
    expect(res.content).toContain('план')
  })

  it('нет projectId для манифеста → ошибка скоупа', async () => {
    const res = await project(() => undefined).ls('/')
    expect(res.error).toBeTruthy()
  })
})
