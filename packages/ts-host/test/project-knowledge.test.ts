import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestScope } from '../src/als'
import {
  findProjectDocumentByTitle,
  indexToProject,
  ProjectKnowledgeError,
  ProjectPoolError,
  serviceToken,
  ServiceTokenError,
  uploadToProjectPool,
  type ProjectKnowledgeRefResult,
  type UploadToProjectPoolOptions,
} from '../src/project-knowledge'

interface Captured {
  url: string
  init: RequestInit & { duplex?: string }
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> }

/** fetch, который отвечает по очереди заданными ответами и запоминает запросы. */
function scriptedFetch(...replies: Reply[]) {
  const calls: Captured[] = []
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...reply.headers },
    })
  })
  return { impl: impl as unknown as typeof fetch, calls, spy: impl }
}

function headersOf(call: Captured): Record<string, string> {
  return call.init.headers as Record<string, string>
}

const PDF = new TextEncoder().encode('%PDF-1.7 тело')

function upload(over: Partial<UploadToProjectPoolOptions> = {}): UploadToProjectPoolOptions {
  return {
    documentServiceUrl: 'http://ds/',
    projectKey: 'b1f0c2d4-0000-4000-8000-000000000001',
    file: PDF,
    fileName: 'Протокол расчёта (a1b2c3d4).pdf',
    bearer: 'jwt-user',
    ...over,
  }
}

describe('uploadToProjectPool', () => {
  it('шлёт файл телом с заголовками контракта DS и возвращает seriesId', async () => {
    const { impl, calls } = scriptedFetch({ status: 201, body: { id: 'series-1' } })
    const res = await uploadToProjectPool(upload({ fetchImpl: impl, projectName: 'ЖК «Сосны»' }))

    expect(res).toEqual({ seriesId: 'series-1' })
    expect(calls[0].url).toBe(
      'http://ds/api/project-pools/b1f0c2d4-0000-4000-8000-000000000001/documents',
    )
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.body).toBe(PDF)
    expect(headersOf(calls[0])).toMatchObject({
      Authorization: 'Bearer jwt-user',
      'Content-Type': 'application/pdf',
      'Content-Length': String(PDF.byteLength),
      'X-File-Name': encodeURIComponent('Протокол расчёта (a1b2c3d4).pdf'),
      'X-Project-Name': encodeURIComponent('ЖК «Сосны»'),
    })
  })

  it('без projectName не шлёт X-Project-Name, не-PDF уходит как octet-stream', async () => {
    const { impl, calls } = scriptedFetch({ status: 201, body: { id: 's' } })
    await uploadToProjectPool(upload({ fetchImpl: impl, fileName: 'отчёт.docx' }))
    expect(headersOf(calls[0])['X-Project-Name']).toBeUndefined()
    expect(headersOf(calls[0])['Content-Type']).toBe('application/octet-stream')
  })

  it('поток уходит полудуплексом с размером из опций', async () => {
    const { impl, calls } = scriptedFetch({ status: 201, body: { id: 's' } })
    const stream = new Blob([PDF]).stream()
    await uploadToProjectPool(upload({ fetchImpl: impl, file: { stream, size: PDF.byteLength } }))
    expect(calls[0].init.body).toBe(stream)
    expect(calls[0].init.duplex).toBe('half')
    expect(headersOf(calls[0])['Content-Length']).toBe(String(PDF.byteLength))
  })

  it('настоящий fetch доносит поток и Content-Length до сервера', async () => {
    const received: { headers?: IncomingHttpHeaders; body?: Buffer } = {}
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received.headers = req.headers
        received.body = Buffer.concat(chunks)
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'series-live' }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const res = await uploadToProjectPool(
        upload({
          documentServiceUrl: `http://127.0.0.1:${port}`,
          file: { stream: new Blob([PDF]).stream(), size: PDF.byteLength },
        }),
      )
      expect(res).toEqual({ seriesId: 'series-live' })
      expect(received.headers?.['content-length']).toBe(String(PDF.byteLength))
      expect(received.headers?.['transfer-encoding']).toBeUndefined()
      expect(decodeURIComponent(String(received.headers?.['x-file-name']))).toBe(
        'Протокол расчёта (a1b2c3d4).pdf',
      )
      expect(received.body?.equals(Buffer.from(PDF))).toBe(true)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('409 duplicate возвращается как duplicateOf, а не ошибкой', async () => {
    const { impl } = scriptedFetch({
      status: 409,
      body: {
        code: 'duplicate',
        error: 'Такой документ уже загружен',
        duplicate: { id: 'old', title: 'Протокол' },
      },
    })
    await expect(uploadToProjectPool(upload({ fetchImpl: impl }))).resolves.toEqual({
      duplicateOf: { id: 'old', title: 'Протокол' },
    })
  })

  it('503 upload_busy — ошибка с retryAfterSeconds из Retry-After', async () => {
    const { impl } = scriptedFetch({
      status: 503,
      body: { code: 'upload_busy', error: 'занят', retryAfterSeconds: 5 },
      headers: { 'Retry-After': '7' },
    })
    const error = await uploadToProjectPool(upload({ fetchImpl: impl })).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProjectPoolError)
    expect(error).toMatchObject({ code: 'upload_busy', status: 503, retryAfterSeconds: 7 })
  })

  it('без Retry-After берёт retryAfterSeconds из тела', async () => {
    const { impl } = scriptedFetch({
      status: 503,
      body: { code: 'upload_busy', retryAfterSeconds: 5 },
    })
    await expect(uploadToProjectPool(upload({ fetchImpl: impl }))).rejects.toMatchObject({
      retryAfterSeconds: 5,
    })
  })

  it.each([
    [404, 'pool_not_found'],
    [409, 'ambiguous_project_pool'],
    [403, 'documents_not_in_plan'],
    [409, 'DOCUMENT_LIMIT_REACHED'],
  ])(
    'HTTP %i — ошибка с кодом DS %s, текст ответа в сообщение не попадает',
    async (status, code) => {
      const { impl } = scriptedFetch({ status, body: { code, error: 'секретный текст ответа' } })
      const error = (await uploadToProjectPool(upload({ fetchImpl: impl })).catch(
        (e: unknown) => e,
      )) as Error
      expect(error).toMatchObject({ code, status })
      expect(error.message).not.toContain('секретный')
      expect(error.message).not.toContain('Протокол')
    },
  )

  it('ответ без кода — upstream_error, сеть — network_error', async () => {
    const { impl } = scriptedFetch({ status: 502 })
    await expect(uploadToProjectPool(upload({ fetchImpl: impl }))).rejects.toMatchObject({
      code: 'upstream_error',
      status: 502,
    })
    const broken = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(uploadToProjectPool(upload({ fetchImpl: broken }))).rejects.toMatchObject({
      code: 'network_error',
    })
  })
})

describe('findProjectDocumentByTitle', () => {
  const doc = (id: string, title: string) => ({
    id,
    title,
    state: 'ready',
    stage: 'ready',
    createdAt: '2026-10-30T00:00:00.000Z',
    pageCount: 3,
    readyPages: 3,
    author: null,
  })
  const base = {
    documentServiceUrl: 'http://ds',
    projectKey: 'p-1',
    bearer: 'jwt-user',
  }

  it('из подстрочной выдачи берёт документ с точно таким названием', async () => {
    const { impl, calls } = scriptedFetch({
      status: 200,
      body: {
        documents: [
          doc('a', 'Протокол расчёта (a1b2c3d4) — копия'),
          doc('b', 'протокол расчёта (a1b2c3d4)'),
          doc('c', 'Протокол расчёта (a1b2c3d4)'),
        ],
        nextCursor: null,
      },
    })
    const found = await findProjectDocumentByTitle({
      ...base,
      title: ' Протокол расчёта (a1b2c3d4) ',
      fetchImpl: impl,
    })
    expect(found?.id).toBe('c')
    const url = new URL(calls[0].url)
    expect(url.pathname).toBe('/api/project-pools/p-1/documents')
    expect(url.searchParams.get('search')).toBe('Протокол расчёта (a1b2c3d4)')
    expect(headersOf(calls[0]).Authorization).toBe('Bearer jwt-user')
  })

  it('нет точного совпадения — null', async () => {
    const { impl } = scriptedFetch({
      status: 200,
      body: { documents: [doc('a', 'Протокол расчёта (a1b2c3d4) v2')], nextCursor: null },
    })
    await expect(
      findProjectDocumentByTitle({
        ...base,
        title: 'Протокол расчёта (a1b2c3d4)',
        fetchImpl: impl,
      }),
    ).resolves.toBeNull()
  })

  it('листает страницы по nextCursor', async () => {
    const { impl, calls } = scriptedFetch(
      { status: 200, body: { documents: [doc('a', 'Отчёт 1')], nextCursor: 'cur-2' } },
      { status: 200, body: { documents: [doc('b', 'Отчёт')], nextCursor: null } },
    )
    const found = await findProjectDocumentByTitle({ ...base, title: 'Отчёт', fetchImpl: impl })
    expect(found?.id).toBe('b')
    expect(new URL(calls[1].url).searchParams.get('cursor')).toBe('cur-2')
  })

  it('отказ DS — ошибка с его кодом', async () => {
    const { impl } = scriptedFetch({ status: 403, body: { code: 'documents_not_in_plan' } })
    await expect(
      findProjectDocumentByTitle({ ...base, title: 'Отчёт', fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'documents_not_in_plan', status: 403 })
  })
})

describe('serviceToken', () => {
  afterEach(() => vi.useRealTimers())

  const DISCOVERY: Reply = {
    status: 200,
    body: { token_endpoint: 'https://auth/application/o/token/' },
  }

  it('берёт token_endpoint из discovery и запрашивает client_credentials', async () => {
    const { impl, calls } = scriptedFetch(DISCOVERY, {
      status: 200,
      body: { access_token: 'svc-1', expires_in: 300 },
    })
    const token = await serviceToken({
      issuer: 'https://auth/application/o/discovery-test/',
      clientId: 'client-discovery',
      clientSecret: 'secret',
      fetchImpl: impl,
    })
    expect(token).toBe('svc-1')
    expect(calls[0].url).toBe(
      'https://auth/application/o/discovery-test/.well-known/openid-configuration',
    )
    expect(calls[1].url).toBe('https://auth/application/o/token/')
    expect(calls[1].init.method).toBe('POST')
    expect(Object.fromEntries(new URLSearchParams(String(calls[1].init.body)))).toEqual({
      grant_type: 'client_credentials',
      client_id: 'client-discovery',
      client_secret: 'secret',
    })
  })

  it('второй вызов до истечения сети не трогает, после истечения берёт новый токен', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-30T10:00:00Z'))
    const { impl, spy } = scriptedFetch(
      DISCOVERY,
      { status: 200, body: { access_token: 'svc-old', expires_in: 300 } },
      { status: 200, body: { access_token: 'svc-new', expires_in: 300 } },
    )
    const opts = {
      issuer: 'https://auth/application/o/cache-test/',
      clientId: 'client-cache',
      clientSecret: 'secret',
      fetchImpl: impl,
    }
    expect(await serviceToken(opts)).toBe('svc-old')
    expect(spy).toHaveBeenCalledTimes(2)

    vi.setSystemTime(new Date('2026-10-30T10:03:59Z'))
    expect(await serviceToken(opts)).toBe('svc-old')
    expect(spy).toHaveBeenCalledTimes(2)

    // За минуту до истечения токен уже считается старым; discovery повторно не нужен.
    vi.setSystemTime(new Date('2026-10-30T10:04:01Z'))
    expect(await serviceToken(opts)).toBe('svc-new')
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('параллельные вызовы ждут один запрос токена', async () => {
    const { impl, spy } = scriptedFetch(DISCOVERY, {
      status: 200,
      body: { access_token: 'svc-shared', expires_in: 300 },
    })
    const opts = {
      issuer: 'https://auth/application/o/parallel-test/',
      clientId: 'client-parallel',
      clientSecret: 'secret',
      fetchImpl: impl,
    }
    const tokens = await Promise.all([serviceToken(opts), serviceToken(opts), serviceToken(opts)])
    expect(tokens).toEqual(['svc-shared', 'svc-shared', 'svc-shared'])
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('отказ провайдера — token_rejected без секрета в тексте', async () => {
    const { impl } = scriptedFetch(DISCOVERY, { status: 401, body: { error: 'invalid_client' } })
    const error = (await serviceToken({
      issuer: 'https://auth/application/o/rejected-test/',
      clientId: 'client-rejected',
      clientSecret: 'очень-секретно',
      fetchImpl: impl,
    }).catch((e: unknown) => e)) as Error
    expect(error).toBeInstanceOf(ServiceTokenError)
    expect(error).toMatchObject({ code: 'token_rejected', status: 401 })
    expect(error.message).not.toContain('очень-секретно')
  })

  it('discovery без token_endpoint — discovery_failed', async () => {
    const { impl } = scriptedFetch({ status: 200, body: {} })
    await expect(
      serviceToken({
        issuer: 'https://auth/application/o/broken-discovery/',
        clientId: 'c',
        clientSecret: 's',
        fetchImpl: impl,
      }),
    ).rejects.toMatchObject({ code: 'discovery_failed' })
  })
})

describe('indexToProject', () => {
  const RESULTS: ProjectKnowledgeRefResult[] = [
    { ref: 'project-attachment:f1', status: 'sent', seriesId: 'series-1' },
    { ref: 'project-artifact:a1', status: 'already_indexed', seriesId: 'series-0' },
    { ref: 'project-attachment:f2', status: 'not_indexable', reason: 'raw_not_stored' },
    { ref: 'project-attachment:f3', status: 'busy', retryAfterSeconds: 5 },
    { ref: 'artifact:a2', status: 'rejected', code: 'ref_not_found' },
  ]

  it('шлёт projectId и refs в мост и возвращает результаты по каждому ref', async () => {
    const { impl, calls } = scriptedFetch({
      status: 200,
      body: { projectId: 'p-1', results: RESULTS },
    })
    const res = await indexToProject({
      chatBackendUrl: 'http://cb/',
      projectId: 'p-1',
      refs: RESULTS.map((r) => r.ref),
      bearer: () => 'jwt-user',
      fetchImpl: impl,
    })
    expect(res).toEqual({ projectId: 'p-1', results: RESULTS })
    expect(calls[0].url).toBe('http://cb/api/project-knowledge')
    expect(calls[0].init.method).toBe('POST')
    expect(headersOf(calls[0])).toMatchObject({
      Authorization: 'Bearer jwt-user',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      projectId: 'p-1',
      refs: RESULTS.map((r) => r.ref),
    })
  })

  it('по умолчанию берёт user-JWT из request-scope хода', async () => {
    const { impl, calls } = scriptedFetch({ status: 200, body: { projectId: 'p-1', results: [] } })
    await requestScope.run({ bearer: 'jwt-turn' }, () =>
      indexToProject({ chatBackendUrl: 'http://cb', projectId: 'p-1', refs: [], fetchImpl: impl }),
    )
    expect(headersOf(calls[0]).Authorization).toBe('Bearer jwt-turn')
  })

  it('без JWT — no_scope, запроса нет', async () => {
    const { impl, spy } = scriptedFetch({ status: 200, body: { results: [] } })
    await expect(
      indexToProject({
        chatBackendUrl: 'http://cb',
        projectId: 'p',
        refs: ['artifact:a'],
        fetchImpl: impl,
      }),
    ).rejects.toMatchObject({ code: 'no_scope' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('отказ запроса целиком — ошибка с кодом и кодом сервера', async () => {
    const { impl } = scriptedFetch({ status: 403, body: { error: 'project_forbidden' } })
    const error = await indexToProject({
      chatBackendUrl: 'http://cb',
      projectId: 'p',
      refs: ['artifact:a'],
      bearer: () => 'jwt',
      fetchImpl: impl,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProjectKnowledgeError)
    expect(error).toMatchObject({
      code: 'unauthorized',
      status: 403,
      serverCode: 'project_forbidden',
    })
  })

  it('ответ без results — upstream_error; маршрута нет — not_found', async () => {
    const call = (reply: Reply) =>
      indexToProject({
        chatBackendUrl: 'http://cb',
        projectId: 'p',
        refs: ['artifact:a'],
        bearer: () => 'jwt',
        fetchImpl: scriptedFetch(reply).impl,
      })
    await expect(call({ status: 200, body: { ok: true } })).rejects.toMatchObject({
      code: 'upstream_error',
    })
    await expect(call({ status: 404 })).rejects.toMatchObject({ code: 'not_found' })
  })
})
