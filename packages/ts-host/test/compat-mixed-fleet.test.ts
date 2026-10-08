/**
 * Смешанный парк A2A во время перехода на @a2a-js/sdk 1.x (план docs#465, §3.2, §10).
 *
 * Настоящие HTTP-серверы на случайных портах, настоящие клиенты обеих версий SDK:
 *  - клиент 0.3 (relay ts-host 0.1.0-alpha.49 + ClientFactory 0.3) → хост 1.x (legacyCompat);
 *  - клиент 1.x (relay 0.2 + createAi37ClientFactory) → агент на SDK 0.3;
 *  - клиент 1.x → хост 1.x (интерфейс 1.0).
 * В каждой паре: обычный ход, HITL input-required → продолжение тем же taskId, стрим с прогрессом,
 * «задача не найдена» и терминальная задача → повтор новым диалогом.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ClientFactory as ClientFactoryV03, JsonRpcTransportFactory as JsonRpcV03 } from 'a2a-sdk-v03/client'
import type { Task as TaskV03 } from 'a2a-sdk-v03'
import { createAgentHost, type AgentHandler, type Ai37AgentCardInput } from '../src/index'
import {
  createAi37ClientFactory,
  executeRemoteA2a,
  executeRemoteA2aStreaming,
  type RemoteA2aProgressEvent,
} from '../src/relay/index'
import {
  executeRemoteA2a as executeV03,
  executeRemoteA2aStreaming as executeStreamingV03,
  type RemoteA2aProgressEvent as ProgressV03,
} from './fixtures/relay-v03/execute'
import { startV03Server, type V03Server } from './fixtures/server-v03'

vi.mock('../src/observability/langfuse', () => ({
  withTurnObservability: async (_context: unknown, run: () => Promise<unknown>) => run(),
  injectTraceContext: () => ({}),
}))

const CATALOG = 'urn:test:catalog'

/**
 * Мастер хоста 1.x: два шага формы, затем completed. На каждом ходе эхо входа (для проверки, что
 * compat доносит data-части, `metadata.ai37`, `acceptedOutputModes`, каталоги). Текст `progress`
 * включает события прогресса до финала — тогда финал идёт status-update'ами (стрим 1.x).
 */
const wizard: AgentHandler = {
  async run({ input, emit }) {
    if (input.text?.includes('progress')) {
      emit({ type: 'node', node: 'work' })
      emit({ type: 'reasoning', delta: 'считаю' })
    }
    const step = (input.taskState?.step as number | undefined) ?? 0
    const echo = {
      text: input.text,
      data: input.data,
      contextRefs: input.metadata.context_refs,
      accepted: input.acceptedOutputModes,
      catalogs: input.supportedCatalogIds,
      action: input.action?.name,
    }
    if (step < 2) {
      return {
        status: 'input-required',
        message: `шаг ${step + 1}`,
        followup: { component: 'FormCard', props: { step: step + 1 }, catalogId: CATALOG },
        state: { step: step + 1 },
        result: echo,
      }
    }
    return { status: 'completed', message: 'готово', result: echo }
  },
}

interface HostServer {
  url: string
  seen: IncomingHttpHeaders[]
  close(): Promise<void>
}

async function startHost(): Promise<HostServer> {
  const seen: IncomingHttpHeaders[] = []
  const server: Server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  const card: Ai37AgentCardInput = {
    name: 'host 1.x wizard',
    description: 'd',
    version: '0.0.1',
    url: `${url}/a2a/v1`,
    protocolVersion: '0.3',
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true, pushNotifications: false, extensions: [{ uri: CATALOG, required: false }] },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['text/markdown', 'text/plain'],
    skills: [{ id: 'wizard', name: 'wizard', description: 'd', tags: [] }],
    'x-ai37': { billing: { feature: 'wizard' } },
  }
  const app = createAgentHost({
    card,
    handler: wizard,
    catalogId: CATALOG,
    agentContext: {
      auth: { issuer: 'i', audience: 'a', required: false },
      billing: { baseUrl: 'http://localhost:9999' },
    },
  })
  server.on('request', (req, res) => {
    if (req.url?.startsWith('/a2a/')) seen.push(req.headers)
    app(req, res)
  })
  return { url, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

const formStep = (a2ui: unknown[]): unknown[] =>
  a2ui.map((item) => ((item as { component: { props: { step: number } } }).component.props.step))

// ───────────────────────── клиент 0.3 → хост 1.x ─────────────────────────

describe('клиент 0.3 (relay ts-host 0.1) → хост на @a2a-js/sdk 1.x (legacyCompat)', () => {
  let host: HostServer
  const factory = new ClientFactoryV03({ transports: [new JsonRpcV03()] })

  beforeAll(async () => {
    host = await startHost()
  })
  afterAll(() => host.close())

  it('карточка гибридная: клиент 0.3 подключается по url, x-ai37 на месте', async () => {
    const card = await (await fetch(`${host.url}/.well-known/agent-card.json`)).json()
    expect(card.url).toBe(`${host.url}/a2a/v1`)
    expect(card['x-ai37']).toEqual({ billing: { feature: 'wizard' } })
    expect(card.supportedInterfaces.map((i: { protocolVersion: string }) => i.protocolVersion)).toEqual(['1.0', '0.3'])
    const client = await factory.createFromUrl(host.url)
    const res = await executeV03(client, { query: 'привет' })
    expect(res.state).toBe('input-required')
  })

  it('HITL блокирующий: форма → продолжение тем же taskId → completed; эхо входа доходит', async () => {
    const client = await factory.createFromUrl(host.url)
    const req = {
      query: 'считай',
      contextId: 'ctx-old-1',
      data: { floors: 9 },
      contextRefs: ['chat-attachment:1'],
      acceptedOutputModes: ['text/markdown'],
      supportedCatalogIds: [CATALOG],
    }
    const r1 = await executeV03(client, req)
    expect(r1.state).toBe('input-required')
    expect(r1.text).toBe('шаг 1')
    expect(formStep(r1.a2ui)).toEqual([1])
    // Запрос клиента 0.3 сервер видит без A2A-Version — значит, ушёл в compat.
    expect(host.seen.at(-1)?.['a2a-version']).toBeUndefined()

    const r2 = await executeV03(client, { ...req, resumeTaskId: r1.taskId, action: { name: 'apply', context: {} } })
    expect(r2.taskId).toBe(r1.taskId)
    expect(r2.state).toBe('input-required')
    // Только форма текущего шага: форма шага 1 заменена на месте, а не лежит рядом.
    expect(formStep(r2.a2ui)).toEqual([2])

    const r3 = await executeV03(client, { ...req, resumeTaskId: r1.taskId })
    expect(r3.state).toBe('completed')
    expect(r3.text).toBe('готово')
    // Формы прошлых шагов в ответе completed не всплывают; result — эхо входа.
    expect(r3.a2ui).toEqual([])
    const raw = r3.raw as TaskV03
    const result = raw.artifacts?.flatMap((a) => a.parts).find((p) => p.kind === 'data' && 'result' in p.data)
    expect(result?.kind === 'data' && result.data.result).toEqual({
      text: 'считай',
      data: { floors: 9 },
      contextRefs: ['chat-attachment:1'],
      accepted: ['text/markdown'],
      catalogs: [CATALOG],
    })
  })

  it('стрим с прогрессом: события доходят, форма приходит, продолжение тем же taskId', async () => {
    const client = await factory.createFromUrl(host.url)
    const seen: ProgressV03[] = []
    const req = { query: 'progress', contextId: 'ctx-old-2', supportedCatalogIds: [CATALOG] }
    const r1 = await executeStreamingV03(client, req, (e) => seen.push(e))
    expect(seen).toEqual([
      { type: 'node', value: 'work' },
      { type: 'reasoning', value: 'считаю' },
    ])
    expect(r1.state).toBe('input-required')
    // Relay 0.3 не читает metadata status-update: форма доезжает только потому, что она в артефакте.
    expect(formStep(r1.a2ui)).toEqual([1])

    const r2 = await executeStreamingV03(client, { ...req, resumeTaskId: r1.taskId }, () => {})
    expect(r2.taskId).toBe(r1.taskId)
    expect(formStep(r2.a2ui)).toEqual([2])
    const r3 = await executeStreamingV03(client, { ...req, resumeTaskId: r1.taskId }, () => {})
    expect(r3.state).toBe('completed')
    expect(r3.text).toBe('готово')
    expect(r3.a2ui).toEqual([])
  })

  it('resume неизвестного taskId → «task not found» → повтор новым диалогом (и на стриме)', async () => {
    const client = await factory.createFromUrl(host.url)
    const res = await executeV03(client, { query: 'x', resumeTaskId: 'no-such-task' })
    expect(res.staleResumeDropped).toBe(true)
    expect(res.state).toBe('input-required')
    expect(res.taskId).not.toBe('no-such-task')

    // Так relay 0.3 переживает паузу, потерянную при переезде агента на новый стор (§3.2 плана):
    // ошибка до первого события стрима приходит событием SSE, а не JSON, который клиент 0.3 не разбирает.
    const streamed = await executeStreamingV03(client, { query: 'x', resumeTaskId: 'no-such-task' }, () => {})
    expect(streamed.staleResumeDropped).toBe(true)
    expect(streamed.state).toBe('input-required')
  })

  it('resume завершённой задачи → терминальная ошибка → повтор новым диалогом (и на стриме)', async () => {
    const client = await factory.createFromUrl(host.url)
    const r1 = await executeV03(client, { query: 'x', contextId: 'ctx-old-3' })
    await executeV03(client, { query: 'x', contextId: 'ctx-old-3', resumeTaskId: r1.taskId })
    const done = await executeV03(client, { query: 'x', contextId: 'ctx-old-3', resumeTaskId: r1.taskId })
    expect(done.state).toBe('completed')

    const again = await executeV03(client, { query: 'x', contextId: 'ctx-old-3', resumeTaskId: r1.taskId })
    expect(again.staleResumeDropped).toBe(true)
    expect(again.taskId).not.toBe(r1.taskId)

    const streamed = await executeStreamingV03(
      client,
      { query: 'x', contextId: 'ctx-old-3', resumeTaskId: r1.taskId },
      () => {},
    )
    expect(streamed.staleResumeDropped).toBe(true)
  })
})

describe('legacyCompat: false', () => {
  it('карточка без 0.3-интерфейса, клиент 0.3 не принят, клиент 1.x работает', async () => {
    const server: Server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const app = createAgentHost({
      card: {
        name: 'strict', description: 'd', version: '1', url: `${url}/a2a/v1`,
        capabilities: { streaming: true }, defaultInputModes: [], defaultOutputModes: ['text/plain'],
        skills: [],
      },
      handler: wizard,
      legacyCompat: false,
      agentContext: { auth: { issuer: 'i', audience: 'a', required: false }, billing: { baseUrl: 'http://x' } },
    })
    server.on('request', app)
    try {
      const card = await (await fetch(`${url}/.well-known/agent-card.json`)).json()
      expect(card.supportedInterfaces).toEqual([
        { url: `${url}/a2a/v1`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ])
      const legacy = await fetch(`${url}/a2a/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'message/send',
          params: { message: { kind: 'message', messageId: 'm', role: 'user', parts: [{ kind: 'text', text: 'x' }] } },
        }),
      })
      expect((await legacy.json()).error).toBeDefined()
      const client = await createAi37ClientFactory().createFromUrl(url)
      expect((await executeRemoteA2a(client, { query: 'x' })).state).toBe('input-required')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

// ───────────────────────── клиент 1.x → агент 0.3 ─────────────────────────

describe('клиент 1.x (relay 0.2, createAi37ClientFactory) → агент на @a2a-js/sdk 0.3', () => {
  let hybrid: V03Server
  let pure: V03Server

  beforeAll(async () => {
    hybrid = await startV03Server({ hybridCard: true })
    pure = await startV03Server({ hybridCard: false })
  })
  afterAll(async () => {
    await hybrid.close()
    await pure.close()
  })

  for (const kind of ['карточка ts-host 0.1 (supportedInterfaces 0.3)', 'чистая карточка 0.3'] as const) {
    it(`${kind}: legacy-транспорт, HITL форма из metadata.a2ui → продолжение тем же taskId`, async () => {
      const agent = kind.startsWith('чистая') ? pure : hybrid
      const client = await createAi37ClientFactory().createFromUrl(agent.url)
      expect(client.protocolVersion).toBe('0.3')

      const r1 = await executeRemoteA2a(client, { query: 'x', contextId: 'ctx-new-1' })
      expect(r1.state).toBe('input-required')
      expect(r1.text).toBe('уточните')
      expect(formStep(r1.a2ui)).toEqual([1])
      // Legacy-транспорт не объявляет 1.0: сервер 0.3 видит запрос 0.3.
      expect(agent.seen.at(-1)?.['a2a-version'] ?? '0.3').toBe('0.3')

      const r2 = await executeRemoteA2a(client, { query: 'x', contextId: 'ctx-new-1', resumeTaskId: r1.taskId })
      expect(r2.taskId).toBe(r1.taskId)
      expect(r2.state).toBe('completed')
      expect(r2.text).toBe('готово')
    })
  }

  it('стрим с прогрессом: StreamResponse из legacy-транспорта, финальная задача с формой', async () => {
    const client = await createAi37ClientFactory().createFromUrl(hybrid.url)
    const seen: RemoteA2aProgressEvent[] = []
    const res = await executeRemoteA2aStreaming(client, { query: 'progress' }, (e) => seen.push(e))
    expect(seen).toEqual([{ type: 'node', value: 'work' }])
    expect(res.state).toBe('input-required')
    expect(formStep(res.a2ui)).toEqual([1])
  })

  it('resume неизвестного taskId → TaskNotFound → повтор новым диалогом', async () => {
    const client = await createAi37ClientFactory().createFromUrl(hybrid.url)
    const res = await executeRemoteA2a(client, { query: 'x', resumeTaskId: 'no-such-task' })
    expect(res.staleResumeDropped).toBe(true)
    expect(res.state).toBe('input-required')
  })

  it('resume завершённой задачи → терминальная ошибка 0.3 → повтор (и на стриме)', async () => {
    const client = await createAi37ClientFactory().createFromUrl(hybrid.url)
    const r1 = await executeRemoteA2a(client, { query: 'x', contextId: 'ctx-new-2' })
    await executeRemoteA2a(client, { query: 'x', contextId: 'ctx-new-2', resumeTaskId: r1.taskId })
    const again = await executeRemoteA2a(client, { query: 'x', contextId: 'ctx-new-2', resumeTaskId: r1.taskId })
    expect(again.staleResumeDropped).toBe(true)
    const streamed = await executeRemoteA2aStreaming(
      client,
      { query: 'x', contextId: 'ctx-new-2', resumeTaskId: r1.taskId },
      () => {},
    )
    expect(streamed.staleResumeDropped).toBe(true)
  })

  it('fetchImpl фабрики уходит и в резолвер карточки, и в транспорт (форвард авторизации)', async () => {
    const urls: string[] = []
    const fetchImpl: typeof fetch = (input, init) => {
      urls.push(String(input instanceof Request ? input.url : input))
      const headers = new Headers(init?.headers)
      headers.set('Authorization', 'Bearer user-jwt')
      return fetch(input, { ...init, headers })
    }
    const client = await createAi37ClientFactory(fetchImpl).createFromUrl(hybrid.url)
    await executeRemoteA2a(client, { query: 'x' })
    expect(urls.some((u) => u.endsWith('/.well-known/agent-card.json'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/a2a/v1'))).toBe(true)
    expect(hybrid.seen.at(-1)?.authorization).toBe('Bearer user-jwt')
  })
})

// ───────────────────────── клиент 1.x → хост 1.x ─────────────────────────

describe('клиент 1.x → хост 1.x: интерфейс 1.0', () => {
  let host: HostServer

  beforeAll(async () => {
    host = await startHost()
  })
  afterAll(() => host.close())

  it('выбран интерфейс 1.0 (A2A-Version: 1.0), HITL по шагам без старых форм, эхо входа', async () => {
    const client = await createAi37ClientFactory().createFromUrl(host.url)
    expect(client.protocolVersion).toBe('1.0')
    const req = {
      query: 'считай',
      contextId: 'ctx-v1-1',
      data: { floors: 9 },
      contextRefs: ['chat-attachment:1'],
      acceptedOutputModes: ['text/markdown'],
      supportedCatalogIds: [CATALOG],
    }
    const r1 = await executeRemoteA2a(client, req)
    expect(host.seen.at(-1)?.['a2a-version']).toBe('1.0')
    expect(r1.state).toBe('input-required')
    expect(formStep(r1.a2ui)).toEqual([1])

    const r2 = await executeRemoteA2a(client, { ...req, resumeTaskId: r1.taskId, action: { name: 'apply', context: {} } })
    expect(formStep(r2.a2ui)).toEqual([2])
    const r3 = await executeRemoteA2a(client, { ...req, resumeTaskId: r1.taskId })
    expect(r3.state).toBe('completed')
    expect(r3.a2ui).toEqual([])
    const raw = r3.raw as { artifacts: { name: string; parts: { content?: { $case: string; value: any } }[] }[] }
    const result = raw.artifacts.find((a) => a.name === 'result')?.parts[0]?.content?.value.result
    expect(result).toEqual({
      text: 'считай',
      data: { floors: 9 },
      contextRefs: ['chat-attachment:1'],
      accepted: ['text/markdown'],
      catalogs: [CATALOG],
    })
  })

  it('стрим с прогрессом: события, форма, state; продолжение тем же taskId', async () => {
    const client = await createAi37ClientFactory().createFromUrl(host.url)
    const seen: RemoteA2aProgressEvent[] = []
    const req = { query: 'progress', contextId: 'ctx-v1-2', supportedCatalogIds: [CATALOG] }
    const r1 = await executeRemoteA2aStreaming(client, req, (e) => seen.push(e))
    expect(seen).toEqual([
      { type: 'node', value: 'work' },
      { type: 'reasoning', value: 'считаю' },
    ])
    expect(r1.state).toBe('input-required')
    expect(formStep(r1.a2ui)).toEqual([1])
    const r2 = await executeRemoteA2aStreaming(client, { ...req, resumeTaskId: r1.taskId }, () => {})
    expect(formStep(r2.a2ui)).toEqual([2])
    const r3 = await executeRemoteA2aStreaming(client, { ...req, resumeTaskId: r1.taskId }, () => {})
    expect(r3.state).toBe('completed')
    expect(r3.a2ui).toEqual([])
  })

  it('«task not found» и терминальная задача → повтор новым диалогом', async () => {
    const client = await createAi37ClientFactory().createFromUrl(host.url)
    const missing = await executeRemoteA2a(client, { query: 'x', resumeTaskId: 'no-such-task' })
    expect(missing.staleResumeDropped).toBe(true)

    const r1 = await executeRemoteA2a(client, { query: 'x', contextId: 'ctx-v1-3' })
    await executeRemoteA2a(client, { query: 'x', contextId: 'ctx-v1-3', resumeTaskId: r1.taskId })
    await executeRemoteA2a(client, { query: 'x', contextId: 'ctx-v1-3', resumeTaskId: r1.taskId })
    const again = await executeRemoteA2a(client, { query: 'x', contextId: 'ctx-v1-3', resumeTaskId: r1.taskId })
    expect(again.staleResumeDropped).toBe(true)
    expect(again.taskId).not.toBe(r1.taskId)
  })
})
