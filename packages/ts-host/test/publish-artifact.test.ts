import { describe, it, expect, vi } from 'vitest'
import { requestScope } from '../src/als'
import {
  ArtifactPublishError,
  artifactErrorCode,
  defaultIdempotencyKey,
  publishArtifact,
  type PublishArtifactOptions,
} from '../src/artifacts/publish-artifact'

const MARKDOWN = '# Протокол\n\nСекретная выкладка расчёта 42'

const ARTIFACT = {
  id: 'a-1',
  kind: 'lift-report',
  name: 'Протокол',
  summary: 'Протокол',
  scope: 'chat',
  contextId: 'ctx-1',
  sha256: 'abc',
  createdAt: '2026-10-08T00:00:00.000Z',
  expiresAt: '2026-11-07T00:00:00.000Z',
  files: [],
}

interface Captured {
  url: string
  init: RequestInit
}

/** fetch, отвечающий заданным статусом и телом; запоминает запросы. */
function fakeFetch(status: number, body: unknown, calls: Captured[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

function opts(over: Partial<PublishArtifactOptions> = {}): PublishArtifactOptions {
  return {
    baseUrl: 'http://chat/',
    kind: 'lift-report',
    name: 'Протокол',
    markdown: MARKDOWN,
    producerAgentId: 'elevator-calc',
    ...over,
  }
}

/** Выполняет fn внутри хода: user-JWT и диалог в request-scope, как их кладёт хост. */
function inTurn<T>(fn: () => Promise<T>, bearer = 'user-jwt'): Promise<T> {
  return requestScope.run({ bearer, turn: { contextId: 'ctx-1', taskId: 'task-1' } }, fn)
}

describe('publishArtifact: fail-closed', () => {
  it('без хода (нет JWT и диалога) — no_scope, запроса нет', async () => {
    const fetchImpl = vi.fn()

    await expect(publishArtifact(opts({ fetchImpl }))).rejects.toMatchObject({
      name: 'ArtifactPublishError',
      code: 'no_scope',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('есть диалог, нет JWT — no_scope', async () => {
    const fetchImpl = vi.fn()

    await expect(
      requestScope.run({ turn: { contextId: 'ctx-1', taskId: 't' } }, () =>
        publishArtifact(opts({ fetchImpl })),
      ),
    ).rejects.toMatchObject({ code: 'no_scope' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('есть JWT, нет диалога — no_scope', async () => {
    const fetchImpl = vi.fn()

    await expect(
      requestScope.run({ bearer: 'jwt' }, () => publishArtifact(opts({ fetchImpl }))),
    ).rejects.toMatchObject({ code: 'no_scope' })
  })
})

describe('publishArtifact: запрос', () => {
  it('POST /api/artifacts с user-JWT хода и полями формы из хода', async () => {
    const calls: Captured[] = []

    const res = await inTurn(() =>
      publishArtifact(
        opts({
          fetchImpl: fakeFetch(201, { artifact: ARTIFACT }, calls),
          producerSkillId: 'calc',
          metadata: { building: 'A' },
          project: true,
        }),
      ),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://chat/api/artifacts')
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer user-jwt')
    const form = calls[0].init.body as FormData
    expect(form.get('contextId')).toBe('ctx-1')
    expect(form.get('taskId')).toBe('task-1')
    expect(form.get('kind')).toBe('lift-report')
    expect(form.get('markdown')).toBe(MARKDOWN)
    expect(form.get('producerSkillId')).toBe('calc')
    expect(form.get('metadata')).toBe('{"building":"A"}')
    expect(form.get('project')).toBe('true')
    expect(String(form.get('idempotencyKey'))).toMatch(/^auto:[0-9a-f]{64}$/)
    // tenant/владельца клиент не шлёт вовсе — их берёт chat-backend из JWT.
    expect(form.has('tenantId')).toBe(false)
    expect(res).toMatchObject({
      id: 'a-1',
      created: true,
      ref: 'artifact:a-1',
      url: '/api/artifacts/a-1',
    })
  })

  it('файлы уходят частями `files` с именем и MIME', async () => {
    const calls: Captured[] = []

    await inTurn(() =>
      publishArtifact(
        opts({
          fetchImpl: fakeFetch(201, { artifact: ARTIFACT }, calls),
          files: [
            { fileName: 'пакет.zip', mime: 'application/zip', data: new Uint8Array([1, 2, 3]) },
            { fileName: 'raw.bin', data: new Uint8Array([9]) },
          ],
        }),
      ),
    )

    const parts = (calls[0].init.body as FormData).getAll('files') as File[]
    expect(parts.map((p) => [p.name, p.type, p.size])).toEqual([
      ['пакет.zip', 'application/zip', 3],
      ['raw.bin', 'application/octet-stream', 1],
    ])
  })

  it('явные contextId/taskId/bearer перекрывают request-scope', async () => {
    const calls: Captured[] = []

    await publishArtifact(
      opts({
        fetchImpl: fakeFetch(201, { artifact: ARTIFACT }, calls),
        contextId: 'ctx-x',
        taskId: 'task-x',
        bearer: () => 'explicit',
      }),
    )

    expect((calls[0].init.body as FormData).get('contextId')).toBe('ctx-x')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer explicit')
  })

  it('повтор: 200 → created=false; ref проекта — project-artifact', async () => {
    const res = await inTurn(() =>
      publishArtifact(
        opts({
          fetchImpl: fakeFetch(200, {
            artifact: { ...ARTIFACT, scope: 'project', projectId: 'p1' },
          }),
        }),
      ),
    )

    expect(res).toMatchObject({ created: false, ref: 'project-artifact:a-1' })
  })
})

describe('defaultIdempotencyKey', () => {
  const base = opts()

  it('тот же ход и содержимое — тот же ключ (ретрай не плодит дубль)', () => {
    expect(defaultIdempotencyKey(base, 'ctx', 't')).toBe(defaultIdempotencyKey(base, 'ctx', 't'))
  })

  it('другой markdown, файл, ход или диалог — другой ключ', () => {
    const k = defaultIdempotencyKey(base, 'ctx', 't')
    expect(defaultIdempotencyKey({ ...base, markdown: 'x' }, 'ctx', 't')).not.toBe(k)
    expect(
      defaultIdempotencyKey(
        { ...base, files: [{ fileName: 'a', data: new Uint8Array([1]) }] },
        'ctx',
        't',
      ),
    ).not.toBe(k)
    expect(defaultIdempotencyKey(base, 'ctx', 't2')).not.toBe(k)
    expect(defaultIdempotencyKey(base, 'ctx2', 't')).not.toBe(k)
  })

  it('порядок файлов не важен', () => {
    const a = { fileName: 'a', data: new Uint8Array([1]) }
    const b = { fileName: 'b', data: new Uint8Array([2]) }
    expect(defaultIdempotencyKey({ ...base, files: [a, b] }, 'c', 't')).toBe(
      defaultIdempotencyKey({ ...base, files: [b, a] }, 'c', 't'),
    )
  })

  it('свой ключ вызывающего уходит как есть', async () => {
    const calls: Captured[] = []
    await inTurn(() =>
      publishArtifact(
        opts({ idempotencyKey: 'mine', fetchImpl: fakeFetch(201, { artifact: ARTIFACT }, calls) }),
      ),
    )
    expect((calls[0].init.body as FormData).get('idempotencyKey')).toBe('mine')
  })
})

describe('publishArtifact: нормализация ошибок', () => {
  it.each([
    [400, 'invalid_input'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not_found'],
    [409, 'conflict'],
    [413, 'too_large'],
    [429, 'rate_limited'],
    [503, 'storage_unavailable'],
    [500, 'upstream_error'],
    [502, 'upstream_error'],
  ] as const)('HTTP %i → %s', async (status, code) => {
    expect(artifactErrorCode(status)).toBe(code)
    await expect(
      inTurn(() => publishArtifact(opts({ fetchImpl: fakeFetch(status, { error: 'x_code' }) }))),
    ).rejects.toMatchObject({ code, status, serverCode: 'x_code' })
  })

  it('сеть или таймаут → network_error', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch

    await expect(inTurn(() => publishArtifact(opts({ fetchImpl })))).rejects.toMatchObject({
      code: 'network_error',
    })
  })

  it('200 без artifact в теле → upstream_error', async () => {
    await expect(
      inTurn(() => publishArtifact(opts({ fetchImpl: fakeFetch(201, {}) }))),
    ).rejects.toMatchObject({ code: 'upstream_error' })
  })

  it('в тексте ошибки нет ни тела артефакта, ни произвольного текста ответа, ни JWT', async () => {
    const fetchImpl = fakeFetch(400, { error: `boom ${MARKDOWN}` })

    const err = (await inTurn(() => publishArtifact(opts({ fetchImpl }))).catch(
      (e: unknown) => e,
    )) as ArtifactPublishError

    expect(err).toBeInstanceOf(ArtifactPublishError)
    expect(err.message).not.toContain('Секретная')
    expect(err.message).not.toContain('user-jwt')
    // Длинный/непохожий на код текст ответа в serverCode не попадает.
    expect(err.serverCode).toBeUndefined()
    expect(err.message).toBe('publishArtifact: invalid_input (HTTP 400)')
  })
})
