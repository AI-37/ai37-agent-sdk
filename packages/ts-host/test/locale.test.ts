/**
 * Локаль хода (план docs#589, срез 3): host кладёт её в scope на обоих входах (AG-UI и A2A), когниция
 * читает `currentLocale()` / `withUserLocale()`, relay форвардит `metadata.ai37.locale` сабагенту,
 * фолбэки статусов хоста идут на языке хода.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AgentContext } from '@ai37/agent-sdk'
import type { Client } from '@a2a-js/sdk/client'
import {
  createAgentHost,
  currentLocale,
  requestScope,
  toTask,
  withUserLocale,
  type AgentHandler,
  type AgentResult,
  type Ai37AgentCardInput,
} from '../src/index'
import { createAi37ClientFactory, executeRemoteA2a } from '../src/relay/index'
import { createSkillDispatchHandler, createSkillRegistry, type SkillProvider } from '../src/skills/index'
import { bridgeHandlerToMcpTool } from '../src/mcp/bridge'
import { HOST_MESSAGES } from '../src/host-messages'
import { negotiateOutput } from '../src/output-modes'

vi.mock('../src/observability/langfuse', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withTurnObservability: async (_context: unknown, run: () => Promise<unknown>) => run(),
  injectTraceContext: () => ({}),
}))

const ctxWithClaims = (claims: Record<string, unknown>): AgentContext =>
  ({ claims }) as unknown as AgentContext

describe('currentLocale', () => {
  it('вне хода — ru, как до локали', () => {
    expect(currentLocale()).toBe('ru')
  })

  it('локаль scope важнее claims', () => {
    requestScope.run({ locale: 'es-MX', ctx: ctxWithClaims({ locale: 'de' }) }, () => {
      expect(currentLocale()).toBe('es-MX')
    })
  })

  it('без локали в scope (путь MCP) — claim locale, затем org_locale', () => {
    requestScope.run({ ctx: ctxWithClaims({ locale: 'de', org_locale: 'fr' }) }, () => {
      expect(currentLocale()).toBe('de')
    })
    requestScope.run({ ctx: ctxWithClaims({ org_locale: 'fr' }) }, () => {
      expect(currentLocale()).toBe('fr')
    })
  })

  it('scope — один на процесс: subpath-бандлы (skills, relay) видят тот же', () => {
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('ai37.agent-host.requestScope')]).toBe(
      requestScope,
    )
  })
})

describe('withUserLocale', () => {
  const base = 'Ты ассистент по нормам.'

  it('дописывает секцию языка ответа в конец промпта', () => {
    requestScope.run({ locale: 'es' }, () => {
      const out = withUserLocale(base)
      expect(out.startsWith(`${base}\n\n## Язык ответа`)).toBe(true)
      expect(out).toContain('Español (es)')
      expect(out).toContain('«[название, пункт]»')
    })
  })

  it('явная локаль важнее хода', () => {
    requestScope.run({ locale: 'es' }, () => {
      expect(withUserLocale(base, 'fr')).toContain('Français (fr)')
    })
  })

  it('язык вне списка (pl) — тегом, без падения', () => {
    requestScope.run({ locale: 'pl' }, () => {
      expect(withUserLocale(base)).toContain('«pl»')
    })
  })
})

describe('фолбэки статусов хоста', () => {
  const negotiation = negotiateOutput({ acceptedOutputModes: undefined, agentTextModes: [] })
  const statusText = (result: AgentResult): string | undefined => {
    const part = toTask(result, 't', 'c', negotiation).status?.message?.parts[0]?.content
    return part?.$case === 'text' ? part.value : undefined
  }

  it('без локали — по-русски, как раньше', () => {
    expect(statusText({ status: 'failed' })).toBe('Ошибка')
    expect(statusText({ status: 'input-required' })).toBe('Уточните')
  })

  it('на языке хода; регион — по языку; вне словаря — en', () => {
    requestScope.run({ locale: 'es-MX' }, () => {
      expect(statusText({ status: 'failed' })).toBe('Error')
      expect(statusText({ status: 'input-required' })).toBe('Precisa tu solicitud')
    })
    requestScope.run({ locale: 'pl' }, () => {
      expect(statusText({ status: 'input-required' })).toBe('Please clarify')
    })
  })

  it('мост MCP: Готово/Ошибка выполнения на языке хода', async () => {
    const empty: AgentHandler = { run: async () => ({ status: 'completed' }) }
    const tool = bridgeHandlerToMcpTool(empty, { name: 'x', title: 'x', description: 'x' })
    const callText = async () => {
      const out = (await tool.handler({ query: 'q' }, undefined)) as { content: { text: string }[] }
      return out.content[0]!.text
    }
    expect(await callText()).toBe('Готово')
    await requestScope.run({ locale: 'de' }, async () => {
      expect(await callText()).toBe('Fertig')
    })
  })

  it('у каждого текста хоста есть все шесть языков', () => {
    for (const dict of Object.values(HOST_MESSAGES)) {
      expect(Object.keys(dict).sort()).toEqual(['de', 'en', 'es', 'fr', 'pt', 'ru'])
    }
  })
})

/** Агент, который отдаёт, что видит когниция: локаль хода и поле конверта. */
const echoLocale: AgentHandler = {
  async run({ input }) {
    return {
      status: 'completed',
      message: `locale=${currentLocale()}`,
      result: { scope: currentLocale(), envelope: input.metadata.locale ?? null },
    }
  },
}

const baseCard: Ai37AgentCardInput = {
  name: 'locale echo',
  description: 'd',
  version: '0.0.1',
  url: 'http://localhost/a2a/v1',
  protocolVersion: '0.3',
  preferredTransport: 'JSONRPC',
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['text/markdown', 'text/plain'],
  skills: [{ id: 'echo', name: 'echo', description: 'd', tags: [] }],
}

const noAuth = {
  auth: { issuer: 'i', audience: 'a', required: false },
  billing: { baseUrl: 'http://localhost:9999' },
}

describe('вход AG-UI: forwardedProps.ai37.locale → scope', () => {
  const app = createAgentHost({ card: baseCard, handler: echoLocale, agentContext: noAuth })

  it('тег с регионом проходит без обрезки (§10)', async () => {
    const r = await request(app)
      .post('/agui')
      .send({
        threadId: 't-loc',
        runId: 'r1',
        messages: [{ role: 'user', content: 'hola' }],
        forwardedProps: { ai37: { locale: 'es-mx' } },
      })
    expect(r.status).toBe(200)
    expect(r.text).toContain('locale=es-MX')
  })

  it('без локали — ru', async () => {
    const r = await request(app)
      .post('/agui')
      .send({ threadId: 't-ru', runId: 'r1', messages: [{ role: 'user', content: 'привет' }] })
    expect(r.text).toContain('locale=ru')
  })
})

interface LiveHost {
  url: string
  close(): Promise<void>
}

async function startHost(handler: AgentHandler, card: Ai37AgentCardInput = baseCard): Promise<LiveHost> {
  const server: Server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  const app = createAgentHost({ card: { ...card, url: `${url}/a2a/v1` }, handler, agentContext: noAuth })
  server.on('request', (req, res) => app(req, res))
  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

const resultOf = (raw: unknown): Record<string, unknown> | undefined => {
  const artifacts = (raw as { artifacts?: { name?: string; parts: { content?: { $case: string; value: any } }[] }[] })
    .artifacts
  const part = artifacts?.find((a) => a.name === 'result')?.parts[0]?.content
  return part?.$case === 'data' ? (part.value.result as Record<string, unknown>) : undefined
}

describe('вход A2A через relay: locale доходит до сабагента (§10)', () => {
  let host: LiveHost
  let client: Client

  beforeAll(async () => {
    host = await startHost(echoLocale)
    client = await createAi37ClientFactory().createFromUrl(host.url)
  })
  afterAll(() => host.close())

  it('RemoteA2aRequest.locale → metadata.ai37.locale → currentLocale() сабагента', async () => {
    const res = await executeRemoteA2a(client, { query: 'x', locale: 'ca-ES-valencia' })
    expect(res.text).toBe('locale=ca-ES-valencia')
    expect(resultOf(res.raw)).toEqual({ scope: 'ca-ES-valencia', envelope: 'ca-ES-valencia' })
  })

  it('язык вне словаря (pl) не отвергается конвертом и SDK', async () => {
    const res = await executeRemoteA2a(client, { query: 'x', locale: 'pl' })
    expect(res.text).toBe('locale=pl')
  })

  it('без локали — ru (старый оркестратор)', async () => {
    const res = await executeRemoteA2a(client, { query: 'x' })
    expect(res.text).toBe('locale=ru')
  })
})

describe('путь intent.skill: интент через extraMetadata.ai37 не стирает локаль (§10)', () => {
  let host: LiveHost
  let client: Client

  const echoSkill: SkillProvider = {
    id: 'echo',
    card: { id: 'echo', name: 'echo', description: 'd', tags: [] },
    handler: echoLocale,
  }

  beforeAll(async () => {
    const registry = createSkillRegistry([echoSkill], { defaultSkillId: 'echo' })
    host = await startHost(createSkillDispatchHandler(registry))
    client = await createAi37ClientFactory().createFromUrl(host.url)
  })
  afterAll(() => host.close())

  it('скилл получает локаль хода', async () => {
    const res = await executeRemoteA2a(client, {
      query: 'x',
      locale: 'es',
      contextRefs: ['chat-attachment:1'],
      extraMetadata: { ai37: { intent: { skill: 'echo' } } },
    })
    expect(res.text).toBe('locale=es')
  })

  it('отказ диспетчера (скилла нет) — на языке хода', async () => {
    const res = await executeRemoteA2a(client, {
      query: 'x',
      locale: 'es',
      extraMetadata: { ai37: { intent: { skill: 'nope' } } },
    })
    expect(res.state).toBe('failed')
    expect(res.text).toBe('La habilidad solicitada «nope» no está disponible en este agente.')
  })
})
