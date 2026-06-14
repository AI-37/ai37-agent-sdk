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

describe('multi-turn state (HITL)', () => {
  // Мастер: 1-й ход → input-required + state{step:1}; 2-й ход (тот же taskId) →
  // handler видит prior state в input.taskState → completed.
  const wizard: AgentHandler = {
    async run({ input }) {
      const step = (input.taskState?.step as number | undefined) ?? 0
      if (step === 0) {
        return {
          status: 'input-required',
          message: 'уточните',
          followup: { component: 'TextPrompt', props: { text: 'ГОСТ?' } },
          state: { step: 1 },
        }
      }
      return { status: 'completed', message: 'готово', result: { resumedStep: step } }
    },
  }

  function send(app: ReturnType<typeof createAgentHost>, id: string, parts: object[], taskId?: string) {
    return request(app)
      .post('/a2a/v1')
      .send({
        jsonrpc: '2.0',
        id,
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: `m-${id}`,
            role: 'user',
            parts,
            ...(taskId ? { taskId } : {}),
          },
        },
      })
  }

  it('сохраняет state между ходами по taskId (server-side)', async () => {
    const wizardApp = createAgentHost({
      card,
      handler: wizard,
      agentContext: {
        auth: { issuer: 'i', audience: 'a', required: false },
        billing: { baseUrl: 'http://localhost:9999' },
      },
    })

    // ход 1
    const r1 = await send(wizardApp, '1', [{ kind: 'text', text: 'start' }])
    expect(r1.body.result.status.state).toBe('input-required')
    expect(r1.body.result.metadata.state.step).toBe(1)
    const taskId: string = r1.body.result.id

    // ход 2 — тот же taskId, handler видит prior state без эха клиента
    const r2 = await send(wizardApp, '2', [{ kind: 'text', text: 'answer' }], taskId)
    expect(r2.body.result.status.state).toBe('completed')
    expect(r2.body.result.artifacts[0].parts[0].data.result.resumedStep).toBe(1)
  })
})

describe('AG-UI (/agui) канон', () => {
  it('эмитит RUN_STARTED, текст и ACTIVITY_SNAPSHOT a2ui-surface', async () => {
    const r = await request(app())
      .post('/agui')
      .send({ threadId: 't1', runId: 'r1', messages: [{ role: 'user', content: 'hi' }] })

    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toContain('text/event-stream')

    const body = r.text
    expect(body).toContain('RUN_STARTED')
    expect(body).toContain('TEXT_MESSAGE_CONTENT')
    // готовый A2UI -> activity `a2ui-surface` с v0.9-операциями (не tool-call render_a2ui)
    expect(body).toContain('ACTIVITY_SNAPSHOT')
    expect(body).toContain('a2ui-surface')
    expect(body).toContain('a2ui_operations')
    expect(body).toContain('SimpleTable')
    expect(body).not.toContain('a2ui_render')
    expect(body).toContain('RUN_FINISHED')
  })
})
