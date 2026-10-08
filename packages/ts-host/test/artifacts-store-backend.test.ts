import { describe, it, expect } from 'vitest'
import { ArtifactsStoreBackend } from '../src/store-backend/artifacts-store-backend'

const CHAT = [
  {
    id: 'a1',
    kind: 'lift-report',
    name: 'Протокол расчёта лифтов',
    summary: 'Расчёт лифтов',
    isLarge: true,
    createdAt: '2026-10-08',
    files: [{ id: 'f1', fileName: 'пакет.zip', mime: 'application/zip', bytes: 3, sha256: 's' }],
  },
]
const PROJECT = [
  {
    id: 'p1a',
    kind: 'teplo-report',
    name: 'Теплотехника',
    summary: '',
    isLarge: false,
    createdAt: '2026-10-08',
    files: [],
  },
]

/** Сервер: повторяет `/api/artifacts` chat-backend; записывает заголовки авторизации. */
function server(seenAuth: string[] = []): typeof fetch {
  return (async (urlStr: string, init?: RequestInit) => {
    const url = new URL(urlStr)
    seenAuth.push((init?.headers as Record<string, string>)?.Authorization ?? '')
    const p = url.pathname
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (p === '/api/artifacts') {
      if (url.searchParams.get('contextId') === 'ctx1') return json({ artifacts: CHAT })
      if (url.searchParams.get('projectId') === 'proj1') return json({ artifacts: PROJECT })
      return json({ error: 'project_not_found' }, 404)
    }
    if (p === '/api/artifacts/search') {
      return json({
        matches: [{ id: 'a1', kind: 'lift-report', name: 'Протокол', snippet: 'лифтов\n 2' }],
      })
    }
    if (p === '/api/artifacts/a1/content') {
      const offset = url.searchParams.get('offset')
      return json({ content: offset === '1' ? 'строка2' : '# Протокол\nстрока2' })
    }
    if (p === '/api/artifacts/a1') return json({ artifact: CHAT[0] })
    if (p === '/api/artifacts/a1/files/f1') {
      return new Response(new Uint8Array([0x50, 0x4b, 0x03]), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('пакет.zip')}`,
        },
      })
    }
    return json({ error: 'not_found' }, 404)
  }) as unknown as typeof fetch
}

function backend(
  scope: () => { contextId: string } | { projectId: string } | undefined,
  seenAuth: string[] = [],
) {
  return new ArtifactsStoreBackend({
    baseUrl: 'http://chat/',
    scope,
    bearer: () => 'user-jwt',
    fetchImpl: server(seenAuth),
  })
}

describe('ArtifactsStoreBackend', () => {
  it('ls / — манифест артефактов диалога, пути относительные', async () => {
    const res = await backend(() => ({ contextId: 'ctx1' })).ls('/')

    expect(res).toEqual({ files: [{ path: '/a1', is_dir: false, modified_at: '2026-10-08' }] })
  })

  it('read / — markdown-манифест с kind, флагом «большой» и именами файлов', async () => {
    const res = await backend(() => ({ contextId: 'ctx1' })).read('/')

    expect(res.mimeType).toBe('text/markdown')
    expect(res.content).toContain('**Протокол расчёта лифтов** (lift-report) — `/a1`')
    expect(res.content).toContain('большой')
    expect(res.content).toContain('файлы: пакет.zip')
  })

  it('корпус проекта — по projectId', async () => {
    const res = await backend(() => ({ projectId: 'proj1' })).ls('/')

    expect(res.files?.map((f) => f.path)).toEqual(['/p1a'])
  })

  it('пустой корпус — «нет артефактов»', async () => {
    const be = new ArtifactsStoreBackend({
      baseUrl: 'http://chat',
      scope: () => ({ contextId: 'ctx1' }),
      bearer: () => 'x',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ artifacts: [] }), {
          status: 200,
        })) as unknown as typeof fetch,
    })

    expect((await be.read('/')).content).toContain('_нет артефактов_')
  })

  it('read /{id} — окно markdown по id (offset/limit уходят в query)', async () => {
    const be = backend(() => undefined)

    expect(await be.read('/a1')).toEqual({
      content: '# Протокол\nстрока2',
      mimeType: 'text/markdown',
    })
    expect((await be.read('/a1', 1, 1)).content).toBe('строка2')
  })

  it('grep — FTS chat-backend, line=1, фрагмент в одну строку', async () => {
    const res = await backend(() => ({ contextId: 'ctx1' })).grep('лифт')

    expect(res.matches).toEqual([{ path: '/a1', line: 1, text: '[Протокол] лифтов 2' }])
  })

  it('glob — фильтр манифеста по имени', async () => {
    const be = backend(() => ({ contextId: 'ctx1' }))

    expect((await be.glob('*лифт*')).files).toHaveLength(1)
    expect((await be.glob('*смета*')).files).toHaveLength(0)
  })

  it('без корпуса в ходе — ошибка, а не чужие данные', async () => {
    const be = backend(() => undefined)

    expect((await be.ls('/')).error).toContain('корпус')
    expect((await be.grep('x')).error).toContain('корпус')
    expect((await be.glob('x')).error).toContain('корпус')
  })

  it('недоступный артефакт или проект — ошибка с HTTP-статусом', async () => {
    expect((await backend(() => ({ projectId: 'other' })).ls('/')).error).toContain('HTTP 404')
    expect((await backend(() => undefined).read('/zzz')).error).toContain('HTTP 404')
  })

  it('глубокий путь — не наш', async () => {
    expect((await backend(() => undefined).read('/a1/files')).error).toContain('Неизвестный путь')
    expect((await backend(() => ({ contextId: 'ctx1' })).ls('/a1')).error).toContain(
      'Не директория',
    )
  })

  it('read-only: write/edit/readRaw — ошибка', async () => {
    const be = backend(() => ({ contextId: 'ctx1' }))

    expect((await be.write()).error).toContain('неизменяемы')
    expect((await be.edit()).error).toContain('неизменяемы')
    expect((await be.readRaw()).error).toContain('readFile')
  })

  it('readFile — байты файла как есть и имя из Content-Disposition', async () => {
    const res = await backend(() => undefined).readFile('a1', 'f1')

    expect(res).toEqual({
      data: new Uint8Array([0x50, 0x4b, 0x03]),
      mime: 'application/zip',
      fileName: 'пакет.zip',
    })
  })

  it('meta — метаданные по id', async () => {
    expect(await backend(() => undefined).meta('a1')).toMatchObject({
      id: 'a1',
      kind: 'lift-report',
    })
  })

  it('каждый запрос несёт user-JWT', async () => {
    const seen: string[] = []
    const be = backend(() => ({ contextId: 'ctx1' }), seen)

    await be.ls('/')
    await be.read('/a1')
    await be.readFile('a1', 'f1')

    expect(seen).toEqual(['Bearer user-jwt', 'Bearer user-jwt', 'Bearer user-jwt'])
  })
})
