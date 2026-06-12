import { describe, it, expect } from 'vitest'
import request from 'supertest'
import type { AgentCard } from '@a2a-js/sdk'
import { createAgentHost, type AgentHandler } from '../src/index'

const card: AgentCard = {
  name: 'Test Agent',
  description: 'test',
  version: '0.0.0',
  url: 'http://localhost/a2a/v1',
  protocolVersion: '0.3',
  preferredTransport: 'JSONRPC',
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [{ id: 's', name: 's', description: 'd', tags: [] }],
}

const handler: AgentHandler = {
  async run({ input }) {
    return {
      status: 'completed',
      a2ui: [{ component: 'SimpleTable', props: {} }],
      message: 'ok',
      result: { echo: input.text },
    }
  },
}

function app() {
  return createAgentHost({
    card,
    handler,
    agentContext: {
      auth: { issuer: 'https://issuer', audience: 'aud', required: false },
      billing: { baseUrl: 'http://localhost:9999' },
    },
    buildInfo: { name: 'test-agent' },
  })
}

describe('createAgentHost', () => {
  it('GET /api/v1/health → ok', async () => {
    const r = await request(app()).get('/api/v1/health')
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('ok')
  })

  it('отдаёт agent-card', async () => {
    const r = await request(app()).get('/.well-known/agent-card.json')
    expect(r.status).toBe(200)
    expect(r.body.skills.length).toBe(1)
  })

  it('A2A message/send → handler → completed Task с A2UI', async () => {
    const r = await request(app())
      .post('/a2a/v1')
      .send({
        jsonrpc: '2.0',
        id: '1',
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'm1',
            role: 'user',
            parts: [{ kind: 'text', text: 'hi' }],
          },
        },
      })
    expect(r.status).toBe(200)
    expect(r.body.result.status.state).toBe('completed')
    expect(r.body.result.artifacts[0].parts[0].data.a2ui[0].component).toBe(
      'SimpleTable',
    )
  })
})
