import { afterEach, describe, it, expect } from 'vitest'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentCard } from '@a2a-js/sdk'
import {
  OUTPUT_MODE_TEXT,
  OUTPUT_MODE_MARKDOWN,
  OUTPUT_MODE_A2UI_AI37,
} from '@ai37/agent-sdk'
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
  // content-negotiation: агент умеет текст (md/plain) + ai37-A2UI
  defaultOutputModes: [OUTPUT_MODE_MARKDOWN, OUTPUT_MODE_TEXT, OUTPUT_MODE_A2UI_AI37],
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

  it('A2A message/send без acceptedOutputModes → completed Task БЕЗ A2UI (дефолт текст)', async () => {
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
    // дефолт — текст: компоненты не отдаются, но текст (status.message) есть
    expect(r.body.result.artifacts[0].parts[0].data.a2ui).toEqual([])
    expect(r.body.result.status.message.parts[0].text).toBe('ok')
  })

  it('A2A message/send с configuration.acceptedOutputModes(ai37) → Task С A2UI', async () => {
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
          configuration: { acceptedOutputModes: [OUTPUT_MODE_A2UI_AI37] },
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

describe('AG-UI (/agui) канон + content-negotiation', () => {
  it('дефолт (без acceptedOutputModes) → текст, БЕЗ ACTIVITY_SNAPSHOT a2ui-surface', async () => {
    const r = await request(app())
      .post('/agui')
      .send({ threadId: 't1', runId: 'r1', messages: [{ role: 'user', content: 'hi' }] })

    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toContain('text/event-stream')

    const body = r.text
    expect(body).toContain('RUN_STARTED')
    expect(body).toContain('TEXT_MESSAGE_CONTENT')
    // дефолт — текст: A2UI-поверхности нет
    expect(body).not.toContain('a2ui-surface')
    expect(body).not.toContain('SimpleTable')
    expect(body).toContain('RUN_FINISHED')
  })

  it('forwardedProps.ai37.acceptedOutputModes(ai37) → ACTIVITY_SNAPSHOT a2ui-surface с catalogId', async () => {
    const r = await request(app())
      .post('/agui')
      .send({
        threadId: 't1',
        runId: 'r1',
        messages: [{ role: 'user', content: 'hi' }],
        forwardedProps: { ai37: { acceptedOutputModes: [OUTPUT_MODE_A2UI_AI37] } },
      })

    expect(r.status).toBe(200)
    const body = r.text
    expect(body).toContain('TEXT_MESSAGE_CONTENT')
    // A2UI запрошен → activity `a2ui-surface` с v0.9-операциями (не tool-call render_a2ui)
    expect(body).toContain('ACTIVITY_SNAPSHOT')
    expect(body).toContain('a2ui-surface')
    expect(body).toContain('a2ui_operations')
    expect(body).toContain('SimpleTable')
    // catalogId из негоциации (ai37-каталог)
    expect(body).toContain('ai37-a2ui/v1/catalog.json')
    expect(body).not.toContain('a2ui_render')
    expect(body).toContain('RUN_FINISHED')
  })
})

describe('dev-режим (insecure-dev + fake billing) через env', () => {
  const tmp: string[] = []
  function writeTmp(name: string, data: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'ai37-host-dev-'))
    tmp.push(dir)
    const path = join(dir, name)
    writeFileSync(path, JSON.stringify(data), 'utf8')
    return path
  }

  // Хендлер, который требует биллинг и эхает то, что получил из dev-контекста.
  const billingHandler: AgentHandler = {
    async run({ input, ctx }) {
      const state = await ctx!.assertExecutionAllowed()
      return {
        status: 'completed',
        message: 'ok',
        result: {
          billingOrgId: input.billingOrgId,
          remainingTotalTokens: state.remainingTotalTokens,
          llmKey: ctx!.llmKey,
        },
      }
    },
  }

  afterEach(() => {
    delete process.env.AI37_AUTH_MODE
    delete process.env.AI37_DEV_CLAIMS_FILE
    delete process.env.BILLING_MODE
    delete process.env.BILLING_STATE_FILE
    while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true })
  })

  it('required=true: запрос без настоящего JWT проходит, агент видит claims + fake billing', async () => {
    process.env.AI37_AUTH_MODE = 'insecure-dev'
    process.env.AI37_DEV_CLAIMS_FILE = writeTmp('claims.json', {
      iss: 'http://localhost/dev',
      aud: 'ai37-agents',
      sub: 'dev-user-0001',
      exp: 9999999999,
      iat: 0,
      org_id: 'dev-user-0001',
      billing_org_id: 'dev-billing-org',
    })
    process.env.BILLING_MODE = 'fake'
    process.env.BILLING_STATE_FILE = writeTmp('billing.json', {
      orgId: 'dev-user-0001',
      billingOrgId: 'dev-billing-org',
      entitlementStatus: 'active',
      remainingTotalTokens: 777,
      features: [],
      llmKey: 'sk-dev-777',
      stale: false,
    })

    // required:true — в проде без валидного JWT был бы 401; в dev FakeJwtVerifier принимает токен.
    const devApp = createAgentHost({
      card,
      handler: billingHandler,
      agentContext: {
        auth: { issuer: 'https://issuer', audience: 'aud', required: true },
        billing: { baseUrl: 'http://localhost:9999' },
      },
    })

    const r = await request(devApp)
      .post('/a2a/v1')
      .set('Authorization', 'Bearer fake-dev-token')
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
    const data = r.body.result.artifacts[0].parts[0].data.result
    expect(data.billingOrgId).toBe('dev-billing-org')
    expect(data.remainingTotalTokens).toBe(777)
    expect(data.llmKey).toBe('sk-dev-777')
  })
})
