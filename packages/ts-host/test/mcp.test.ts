import { describe, it, expect } from 'vitest'
import request from 'supertest'
import type { AgentCard } from '@a2a-js/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  createAgentHost,
  buildMcpServer,
  bridgeHandlerToMcpTool,
  protectedResourceMetadataUrl,
  deriveAuthorizationServers,
  type AgentHandler,
  type McpToolDef,
} from '../src/index'

const card: AgentCard = {
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

const calcTool: McpToolDef = {
  name: 'calc_lifts',
  description: 'Расчёт лифтов',
  handler: (args) => ({
    content: [{ type: 'text', text: `got:${String(args.query)}` }],
  }),
}

function app(required = false) {
  return createAgentHost({
    card,
    handler,
    agentContext: {
      auth: { issuer: 'https://issuer', audience: 'aud', required },
      billing: { baseUrl: 'http://localhost:9999' },
    },
    mcp: { tools: [calcTool], scopes: ['mcp'] },
    buildInfo: { name: 'test', version: '9.9.9' },
  })
}

describe('mcp resource server — чистые хелперы', () => {
  it('protectedResourceMetadataUrl переносит путь ресурса в суффикс', () => {
    expect(protectedResourceMetadataUrl('https://h/mcp')).toBe(
      'https://h/.well-known/oauth-protected-resource/mcp',
    )
    expect(protectedResourceMetadataUrl('https://h/')).toBe(
      'https://h/.well-known/oauth-protected-resource',
    )
  })

  it('deriveAuthorizationServers: issuers[] приоритетнее legacy issuer', () => {
    expect(
      deriveAuthorizationServers({
        issuers: [
          { issuer: 'a', audience: 'x' },
          { issuer: 'b', audience: 'y' },
        ],
      }),
    ).toEqual(['a', 'b'])
    expect(
      deriveAuthorizationServers({ issuer: 'legacy', audience: 'x' }),
    ).toEqual(['legacy'])
    expect(deriveAuthorizationServers({})).toEqual([])
  })
})

describe('mcp resource server — discovery + challenge', () => {
  it('GET protected-resource-metadata → resource + authorization_servers + scopes', async () => {
    const r = await request(app()).get(
      '/.well-known/oauth-protected-resource/mcp',
    )
    expect(r.status).toBe(200)
    expect(r.body.resource).toBe('http://localhost/mcp')
    expect(r.body.authorization_servers).toEqual(['https://issuer'])
    expect(r.body.scopes_supported).toEqual(['mcp'])
  })

  it('корневой путь метаданных тоже отвечает', async () => {
    const r = await request(app()).get('/.well-known/oauth-protected-resource')
    expect(r.status).toBe(200)
    expect(r.body.resource).toBe('http://localhost/mcp')
  })

  it('POST /mcp без токена (required) → 401 + WWW-Authenticate с resource_metadata', async () => {
    const r = await request(app(true))
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(r.status).toBe(401)
    expect(r.headers['www-authenticate']).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    )
  })
})

describe('mcp resource server — tools через in-memory клиент', () => {
  it('tools/list показывает calc_lifts, tools/call прокидывает query в handler', async () => {
    const server = await buildMcpServer(
      { name: 'test', version: '9.9.9' },
      [calcTool],
      undefined,
    )
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'c', version: '1' })
    await client.connect(clientT)

    const list = await client.listTools()
    expect(list.tools.map((t) => t.name)).toContain('calc_lifts')

    const res = await client.callTool({
      name: 'calc_lifts',
      arguments: { query: 'дом 10 этажей' },
    })
    expect((res.content as Array<{ text: string }>)[0].text).toBe(
      'got:дом 10 этажей',
    )

    await client.close()
    await server.close()
  })
})

describe('bridgeHandlerToMcpTool — мост A2A-скилла в MCP-tool', () => {
  it('строит AgentInput из query, зовёт handler.run, возвращает message', async () => {
    let seen: string | undefined
    const dialogHandler: AgentHandler = {
      async run({ input, ctx }) {
        seen = input.text
        return {
          status: 'input-required',
          message: `эхо:${input.text}:org=${ctx?.billingOrgId ?? 'none'}`,
        }
      },
    }
    const tool = bridgeHandlerToMcpTool(dialogHandler, {
      name: 'calc_lifts',
      description: 'расчёт',
      textModes: ['text/plain'],
    })
    const res = await tool.handler({ query: 'дом 12 этажей' }, undefined)
    expect(seen).toBe('дом 12 этажей')
    expect(res.content[0].text).toBe('эхо:дом 12 этажей:org=none')
    // input-required — не ошибка (диалоговый агент не завершает задачу).
    expect(res.isError).toBe(false)
  })

  it('renderResult переопределяет текст, failed → isError', async () => {
    const failing: AgentHandler = {
      async run() {
        return { status: 'failed', result: { code: 42 } }
      },
    }
    const tool = bridgeHandlerToMcpTool(failing, {
      name: 't',
      description: 'd',
      renderResult: (r) => `status=${r.status}`,
    })
    const res = await tool.handler({ query: 'x' }, undefined)
    expect(res.content[0].text).toBe('status=failed')
    expect(res.isError).toBe(true)
  })
})
