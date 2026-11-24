import { describe, it, expect, afterEach } from 'vitest'
import request from 'supertest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  createAgentHost,
  buildMcpServer,
  type Ai37AgentCardInput,
  type AgentHandler,
  type McpOptions,
  type McpToolDef,
} from '../src/index'

// Инструкции MCP-сервера (`instructions` в ответе `initialize`): ими направляем модель хоста —
// например, «на "рассчитай лифты" открывай форму, а не структурный инструмент». Проверяем
// настоящим клиентом MCP SDK; паритет — `python-host/tests/test_mcp_instructions.py`.

const INSTRUCTIONS =
  'Когда пользователь просит рассчитать лифты, открой форму open_lift_calc_form.'

const tool: McpToolDef = {
  name: 'open_lift_calc_form',
  title: 'Форма расчёта лифтов',
  description: 'Открывает форму расчёта',
  handler: () => ({ content: [{ type: 'text', text: 'ок' }] }),
}

const opened: Array<{ client: Client; server: McpServer }> = []

async function connect(instructions?: string): Promise<Client> {
  const server = await buildMcpServer(
    { name: 'test', version: '9.9.9' },
    [tool],
    undefined,
    [],
    instructions,
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

describe('MCP instructions — buildMcpServer', () => {
  it('initialize отдаёт instructions клиенту', async () => {
    const client = await connect(INSTRUCTIONS)
    expect(client.getInstructions()).toBe(INSTRUCTIONS)
  })

  it('без instructions поля нет, сервер работает как раньше', async () => {
    const client = await connect()
    expect(client.getInstructions()).toBeUndefined()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['open_lift_calc_form'])
  })

  it('пустая строка — то же, что «не задано»', async () => {
    const client = await connect('')
    expect(client.getInstructions()).toBeUndefined()
  })
})

describe('MCP instructions — через HTTP-эндпоинт хоста', () => {
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

  async function initialize(mcp: McpOptions) {
    const app = createAgentHost({
      card,
      handler,
      agentContext: {
        auth: { issuer: 'https://issuer', audience: 'aud', required: false },
        billing: { baseUrl: 'http://localhost:9999' },
      },
      mcp,
      buildInfo: { name: 'test', version: '9.9.9' },
    })
    const r = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'c', version: '1' },
        },
      })
    expect(r.status).toBe(200)
    const line = r.text.split('\n').find((l) => l.startsWith('data: '))!
    return JSON.parse(line.slice(6)).result as Record<string, unknown>
  }

  it('McpOptions.instructions доезжают до initialize на /mcp', async () => {
    const result = await initialize({ tools: [tool], instructions: INSTRUCTIONS })
    expect(result.instructions).toBe(INSTRUCTIONS)
    expect(result.serverInfo).toMatchObject({ name: 'Test Agent' })
  })

  it('без McpOptions.instructions в initialize поля нет', async () => {
    const result = await initialize({ tools: [tool] })
    expect(result).not.toHaveProperty('instructions')
  })
})
