import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import type { Request, Response } from 'express'
import { OUTPUT_MODE_TEXT } from '@ai37/agent-sdk'
import { createAgentHost, type AgentHandler, type Ai37AgentCardInput } from '../src/index'
import { legacyStreamErrorsAsSse } from '../src/legacy-stream-errors'

vi.mock('../src/observability/langfuse', () => ({
  withTurnObservability: async (_context: unknown, run: () => Promise<unknown>) => run(),
  injectTraceContext: () => ({}),
}))

/**
 * Совместимость с клиентами A2A 0.3 на хосте 1.x (ревью 09.10, пункты 1 и 9): семантика `blocking`
 * сервера 0.3 и SSE-обёртка ошибок, которая не прячет сбой сервера.
 */
const card: Ai37AgentCardInput = {
  name: 'Legacy Test Agent',
  description: 'test',
  version: '0.0.0',
  url: 'http://localhost/a2a/v1',
  protocolVersion: '0.3',
  preferredTransport: 'JSONRPC',
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: [OUTPUT_MODE_TEXT],
  skills: [{ id: 's', name: 's', description: 'd', tags: [] }],
}

// Агент с прогрессом: первое событие исполнения — task в `working` (A2aProgress).
const withProgress: AgentHandler = {
  async run({ emit }) {
    emit?.({ type: 'node', node: 'work' })
    await new Promise((r) => setTimeout(r, 20))
    return { status: 'completed', message: 'готово' }
  },
}

const app = () =>
  createAgentHost({
    card,
    handler: withProgress,
    agentContext: {
      auth: { issuer: 'https://issuer', audience: 'aud', required: false },
      billing: { baseUrl: 'http://localhost:9999' },
    },
    buildInfo: { name: 'legacy-test' },
  })

const send0_3 = (configuration?: Record<string, unknown>) =>
  request(app())
    .post('/a2a/v1')
    .send({
      jsonrpc: '2.0',
      id: '1',
      method: 'message/send',
      params: {
        message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'привет' }] },
        ...(configuration ? { configuration } : {}),
      },
    })

describe('клиент 0.3: message/send без configuration.blocking — блокирующий, как у сервера 0.3', () => {
  it('configuration без blocking (только acceptedOutputModes) → ответ после хода, completed', async () => {
    const r = await send0_3({ acceptedOutputModes: ['text/plain'] })
    expect(r.body.result?.kind).toBe('task')
    expect(r.body.result?.status?.state).toBe('completed')
  })

  it('без configuration → тоже completed', async () => {
    const r = await send0_3()
    expect(r.body.result?.status?.state).toBe('completed')
  })

  it('явный blocking: false остаётся неблокирующим — ответ на первом событии', async () => {
    const r = await send0_3({ acceptedOutputModes: ['text/plain'], blocking: false })
    expect(r.body.result?.status?.state).toBe('working')
  })
})

describe('legacyStreamErrorsAsSse: только ошибки протокола, сбой сервера остаётся 500', () => {
  function fakeExchange(statusCode: number) {
    const req = {
      header: () => undefined,
      body: { method: 'message/stream' },
    } as unknown as Request
    const sent: { json?: unknown; sse?: string; status: number } = { status: statusCode }
    const fake = {
      headersSent: false,
      statusCode,
      status: (code: number) => {
        sent.status = code
        fake.statusCode = code
        return fake
      },
      setHeader: () => undefined,
      end: (chunk: string) => {
        sent.sse = chunk
        return fake
      },
      json: (body: unknown) => {
        sent.json = body
        return fake
      },
    }
    const res = fake as unknown as Response
    legacyStreamErrorsAsSse(req, res, () => undefined)
    return { res, sent }
  }
  const rpcError = (code: number) => ({ jsonrpc: '2.0', id: '1', error: { code, message: 'x' } })

  it('ошибка протокола со статусом 200 (задача не найдена) → событие SSE', () => {
    const { res, sent } = fakeExchange(200)
    res.json(rpcError(-32001))
    expect(sent.sse).toContain('event: error')
    expect(sent.json).toBeUndefined()
  })

  it('сбой сервера (500) → JSON с 500, не SSE 200', () => {
    const { res, sent } = fakeExchange(500)
    res.json(rpcError(-32603))
    expect(sent.json).toEqual(rpcError(-32603))
    expect(sent.status).toBe(500)
    expect(sent.sse).toBeUndefined()
  })
})
