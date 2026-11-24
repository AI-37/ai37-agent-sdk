import { describe, it, expect, afterEach } from 'vitest'
import request from 'supertest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  createAgentHost,
  buildMcpServer,
  MCP_APP_MIME_TYPE,
  MCP_APP_RESOURCE_URI_META_KEY,
  type Ai37AgentCardInput,
  type AgentHandler,
  type McpResourceDef,
  type McpToolDef,
  type McpToolResult,
} from '../src/index'

// MCP Apps (спека 2026-01-26) на MCP-поверхности хоста: view-ресурс, `_meta.ui` инструмента и
// результат с `_meta`/`structuredContent`. Всё проверяем настоящим клиентом MCP SDK.

const VIEW_URI = 'ui://elevator/a2ui-surface.html'
const VIEW_HTML = '<!doctype html><html><body>view</body></html>'

const a2uiMeta = {
  'ai37/a2ui': {
    version: 1,
    surfaceId: 'lift',
    messages: [{ version: 'v0.9', createSurface: { surfaceId: 'lift' } }],
    state: { gost: '52941', building: { N: 17 } },
    actionTool: 'lift_form_action',
  },
}

const openFormTool: McpToolDef = {
  name: 'open_lift_calc_form',
  title: 'Форма расчёта лифтов',
  description: 'Открывает форму расчёта',
  annotations: { readOnlyHint: true },
  ui: { resourceUri: VIEW_URI },
  handler: () => ({
    content: [{ type: 'text', text: 'Форма открыта. Предзаполнено: N=17' }],
    _meta: a2uiMeta,
  }),
}

const actionTool: McpToolDef = {
  name: 'lift_form_action',
  title: 'Действие формы лифтов',
  description: 'Служебный: действие формы, вызывает только view',
  inputSchema: {
    name: z.string(),
    context: z.record(z.string(), z.unknown()),
  },
  ui: { resourceUri: VIEW_URI, visibility: ['app'] },
  handler: (args) => ({
    content: [{ type: 'text', text: `действие ${String(args.name)}` }],
    structuredContent: { kind: 'report', ok: true },
    _meta: a2uiMeta,
  }),
}

const plainTool: McpToolDef = {
  name: 'calc_lifts',
  title: 'Расчёт лифтов по ГОСТ',
  description: 'Расчёт лифтов',
  handler: (args) => ({
    content: [{ type: 'text', text: `got:${String(args.query)}` }],
  }),
}

function viewResource(read: () => string | Promise<string> = () => VIEW_HTML) {
  return {
    uri: VIEW_URI,
    name: 'Форма и отчёт расчёта лифтов',
    description: 'A2UI-поверхность внутри MCP App',
    read,
    ui: { csp: { resourceDomains: [] }, prefersBorder: false },
  } satisfies McpResourceDef
}

const opened: Array<{ client: Client; server: McpServer }> = []

async function connect(
  tools: McpToolDef[],
  resources?: McpResourceDef[],
): Promise<Client> {
  const server = await buildMcpServer(
    { name: 'test', version: '9.9.9' },
    tools,
    undefined,
    resources,
  )
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'c', version: '1' })
  await client.connect(clientT)
  opened.push({ client, server })
  return client
}

afterEach(async () => {
  for (const { client, server } of opened.splice(0)) {
    await client.close()
    await server.close()
  }
})

describe('MCP Apps — tools/list', () => {
  it('инструмент с ui несёт _meta.ui и legacy-ключ с тем же URI', async () => {
    const client = await connect([openFormTool], [viewResource()])
    const { tools } = await client.listTools()
    const tool = tools.find((t) => t.name === 'open_lift_calc_form')

    expect(tool?._meta).toEqual({
      ui: { resourceUri: VIEW_URI },
      [MCP_APP_RESOURCE_URI_META_KEY]: VIEW_URI,
    })
    expect(MCP_APP_RESOURCE_URI_META_KEY).toBe('ui/resourceUri')
    // Заголовок и хинты на месте: ui их не вытесняет.
    expect(tool?.title).toBe('Форма расчёта лифтов')
    expect(tool?.annotations).toEqual({
      readOnlyHint: true,
      title: 'Форма расчёта лифтов',
    })
  })

  it('app-only инструмент виден в tools/list с visibility ["app"] — прячет его хост', async () => {
    const client = await connect([openFormTool, actionTool], [viewResource()])
    const { tools } = await client.listTools()

    expect(tools.map((t) => t.name)).toEqual([
      'open_lift_calc_form',
      'lift_form_action',
    ])
    const action = tools.find((t) => t.name === 'lift_form_action')
    expect(action?._meta).toEqual({
      ui: { resourceUri: VIEW_URI, visibility: ['app'] },
      'ui/resourceUri': VIEW_URI,
    })
    expect(action?.title).toBe('Действие формы лифтов')
  })

  it('инструмент без ui — без _meta, как раньше', async () => {
    const client = await connect([plainTool])
    const { tools } = await client.listTools()

    expect(tools).toHaveLength(1)
    // MCP SDK сам кладёт `_meta: tool._meta` в ответ; по сети undefined-поле пропадает.
    expect(tools[0]._meta).toBeUndefined()
  })
})

describe('MCP Apps — resources', () => {
  it('resources/list отдаёт view с MIME профиля и _meta.ui ресурса', async () => {
    const client = await connect([openFormTool], [viewResource()])
    const { resources } = await client.listResources()

    expect(resources).toEqual([
      {
        uri: VIEW_URI,
        name: 'Форма и отчёт расчёта лифтов',
        description: 'A2UI-поверхность внутри MCP App',
        mimeType: 'text/html;profile=mcp-app',
        _meta: { ui: { csp: { resourceDomains: [] }, prefersBorder: false } },
      },
    ])
    expect(MCP_APP_MIME_TYPE).toBe('text/html;profile=mcp-app')
  })

  it('resources/read отдаёт HTML, MIME профиля и _meta.ui в содержимом', async () => {
    const client = await connect([openFormTool], [viewResource()])
    const res = await client.readResource({ uri: VIEW_URI })

    expect(res.contents).toEqual([
      {
        uri: VIEW_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: VIEW_HTML,
        _meta: { ui: { csp: { resourceDomains: [] }, prefersBorder: false } },
      },
    ])
  })

  it('свой mimeType и ресурс без ui: MIME автора, _meta нет', async () => {
    const client = await connect(
      [],
      [
        {
          uri: 'ui://test/plain.txt',
          name: 'plain',
          mimeType: 'text/plain',
          read: async () => 'привет',
        },
      ],
    )
    const { resources } = await client.listResources()
    expect(resources[0].mimeType).toBe('text/plain')
    expect(resources[0]).not.toHaveProperty('_meta')

    const res = await client.readResource({ uri: 'ui://test/plain.txt' })
    expect(res.contents).toEqual([
      { uri: 'ui://test/plain.txt', mimeType: 'text/plain', text: 'привет' },
    ])
  })

  it('read зовётся один раз на процесс, даже если сервер собран заново', async () => {
    let reads = 0
    const resource = viewResource(() => {
      reads += 1
      return VIEW_HTML
    })
    for (let i = 0; i < 2; i += 1) {
      const client = await connect([openFormTool], [resource])
      const res = await client.readResource({ uri: VIEW_URI })
      expect(res.contents[0]).toMatchObject({ text: VIEW_HTML })
    }
    expect(reads).toBe(1)
  })

  it('упавший read не запоминается: следующий запрос читает снова', async () => {
    let reads = 0
    const resource = viewResource(() => {
      reads += 1
      if (reads === 1) throw new Error('файл ещё не готов')
      return VIEW_HTML
    })
    const client = await connect([openFormTool], [resource])

    await expect(client.readResource({ uri: VIEW_URI })).rejects.toThrow(
      'файл ещё не готов',
    )
    const res = await client.readResource({ uri: VIEW_URI })
    expect(res.contents[0]).toMatchObject({ text: VIEW_HTML })
    expect(reads).toBe(2)
  })

  it('неизвестный URI — ошибка протокола, а не пустой ответ', async () => {
    const client = await connect([openFormTool], [viewResource()])
    await expect(
      client.readResource({ uri: 'ui://elevator/nope.html' }),
    ).rejects.toThrow('ui://elevator/nope.html')
  })

  it('без resources сервер не объявляет resources, как раньше', async () => {
    const client = await connect([plainTool])

    expect(client.getServerCapabilities()?.resources).toBeUndefined()
    await expect(client.listResources()).rejects.toThrow()
  })
})

describe('MCP Apps — результат инструмента', () => {
  it('_meta и structuredContent доходят до клиента без потерь', async () => {
    const client = await connect([openFormTool, actionTool], [viewResource()])

    const res = await client.callTool({
      name: 'lift_form_action',
      arguments: { name: 'calc', context: { N: 17 } },
    })

    expect(res.content).toEqual([{ type: 'text', text: 'действие calc' }])
    expect(res.structuredContent).toEqual({ kind: 'report', ok: true })
    expect(res._meta).toEqual(a2uiMeta)
    expect(res.isError).toBeFalsy()
  })

  it('картинка в content проходит как ImageContent', async () => {
    const chart: McpToolDef = {
      name: 'chart',
      title: 'График',
      description: 'd',
      handler: () => ({
        content: [
          { type: 'text', text: 'график ниже' },
          { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        ],
      }),
    }
    const client = await connect([chart])

    const res = await client.callTool({ name: 'chart', arguments: { query: 'x' } })

    expect(res.content).toEqual([
      { type: 'text', text: 'график ниже' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])
  })

  it('инструмент без ui отвечает как раньше: только content, без _meta', async () => {
    const client = await connect([plainTool])

    const res = await client.callTool({
      name: 'calc_lifts',
      arguments: { query: 'дом' },
    })

    expect(res).toEqual({ content: [{ type: 'text', text: 'got:дом' }] })
  })

  it('текст результата читается сужением по type (так его читает агрегатор chat-backend)', () => {
    const result: McpToolResult = {
      content: [
        { type: 'text', text: 'итог' },
        { type: 'image', data: 'AA==', mimeType: 'image/png' },
      ],
    }
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')

    expect(text).toBe('итог')
  })
})

describe('MCP Apps — через HTTP-эндпоинт хоста', () => {
  const card: Ai37AgentCardInput = {
    name: 'Test Agent',
    description: 'test',
    version: '0.0.0',
    url: 'http://localhost/a2a/v1',
    protocolVersion: '0.3',
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 's', name: 's', description: 'd', tags: [] }],
  }
  const handler: AgentHandler = {
    async run() {
      return { status: 'completed', message: 'ok' }
    },
  }

  it('McpOptions.resources доезжают до /mcp: resources/read отдаёт view', async () => {
    const app = createAgentHost({
      card,
      handler,
      agentContext: {
        auth: { issuer: 'https://issuer', audience: 'aud', required: false },
        billing: { baseUrl: 'http://localhost:9999' },
      },
      mcp: { tools: [openFormTool], resources: [viewResource()] },
      buildInfo: { name: 'test', version: '9.9.9' },
    })

    const r = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: VIEW_URI },
      })

    expect(r.status).toBe(200)
    const payload = JSON.parse(
      r.text.split('\n').find((l) => l.startsWith('data: '))!.slice(6),
    )
    expect(payload.result.contents[0]).toMatchObject({
      uri: VIEW_URI,
      mimeType: MCP_APP_MIME_TYPE,
      text: VIEW_HTML,
    })
  })
})
