import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express, { type NextFunction, type Request, type Response } from 'express'
import {
  AuthError,
  BillingConfigurationError,
  type AgentContextOverrides,
  type AgentContextSettings,
  type Claims,
  type JwtVerifier,
} from '@ai37/agent-sdk'
import {
  createTestKeyset,
  FakeJwtVerifier,
  fixtures,
  InMemoryBillingClient,
  TEST_AUDIENCE,
  TEST_ISSUER,
  type TestKeyset,
} from '@ai37/agent-sdk/testing'
import {
  createAgentHost,
  currentCtx,
  jwtGuard,
  type AgentHandler,
  type Ai37AgentCardInput,
} from '../src/index'
import { mcpChallengeGuard } from '../src/mcp/challenge-guard'
import { renderMetrics } from '../src/metrics'

/**
 * Guard'ы fail-closed: при `required` любой сбой проверки завершает запрос (AuthError → 401,
 * остальное → 503), `next()` не вызывается. При `required=false` — аноним, как раньше.
 */

const claims: Claims = {
  iss: 'https://issuer',
  aud: 'aud',
  sub: 'alice',
  exp: 9999999999,
  iat: 0,
  org_id: 'org-1',
  billing_org_id: 'b-org-1',
}

/** Верификатор, который бросает заданное — имитация сбоя JWKS/introspection/бага. */
function throwingVerifier(error: unknown): JwtVerifier {
  return {
    verify: () => Promise.reject(error),
  }
}

/** Без `appsAuthToken`: `createBillingClient` внутри `fromRequest` бросит BillingConfigurationError. */
function settings(required: boolean): AgentContextSettings {
  return {
    auth: { issuer: 'https://issuer', audience: 'aud', required },
    billing: { baseUrl: 'http://localhost:9999' },
  }
}

function guarded(
  required: boolean,
  overrides: AgentContextOverrides,
  service: string,
  guardKind: 'jwt' | 'mcp' = 'jwt',
) {
  const calls: Array<{ sub: string | undefined }> = []
  const app = express()
  app.use(express.json())
  const guard =
    guardKind === 'jwt'
      ? jwtGuard(settings(required), required, overrides, service)
      : mcpChallengeGuard(settings(required), required, 'https://h/.well-known/x', overrides, service)
  app.post('/x', guard, (_req, res) => {
    const sub = currentCtx()?.claims?.sub
    calls.push({ sub })
    res.json({ anonymous: sub === undefined, sub })
  })
  return { app, calls }
}

function post(app: express.Express, bearer?: string) {
  const r = request(app).post('/x')
  return (bearer ? r.set('Authorization', `Bearer ${bearer}`) : r).send({})
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('jwtGuard, required=true', () => {
  it('нет токена (AuthError) → 401, обработчик не вызван', async () => {
    const { app, calls } = guarded(true, {}, 'g-401-missing')
    const r = await post(app)
    expect(r.status).toBe(401)
    expect(r.body.error).toBe('unauthorized')
    expect(calls).toHaveLength(0)
  })

  it('верификатор отверг токен (AuthError) → 401 и ai37_agent_auth_failures_total', async () => {
    const { app, calls } = guarded(
      true,
      { verifier: throwingVerifier(new AuthError('JWT verification failed')) },
      'g-401-invalid',
    )
    const r = await post(app, 'tok')
    expect(r.status).toBe(401)
    expect(calls).toHaveLength(0)
    expect(await renderMetrics()).toMatch(
      /ai37_agent_auth_failures_total\{service="g-401-invalid"\} 1/,
    )
  })

  it('BillingConfigurationError (пустой appsAuthToken) → 503 без деталей, обработчик не вызван', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app, calls } = guarded(true, { verifier: new FakeJwtVerifier(claims) }, 'g-503-billing')
    const r = await post(app, 'opaque-api-key')
    expect(r.status).toBe(503)
    expect(r.body).toEqual({ error: 'auth_unavailable' })
    expect(calls).toHaveLength(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('BillingConfigurationError'))
    expect(await renderMetrics()).toMatch(
      /ai37_agent_auth_guard_errors_total\{service="g-503-billing"\} 1/,
    )
  })

  it.each([
    ['сбой загрузки JWKS вне AuthError', new TypeError('fetch failed')],
    ['BillingConfigurationError из верификатора', new BillingConfigurationError('boom')],
    ['произвольная ошибка', new Error('unexpected')],
    ['не-Error значение', 'string thrown'],
  ])('%s → 503, обработчик не вызван', async (_label, error) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app, calls } = guarded(true, { verifier: throwingVerifier(error) }, 'g-503-generic')
    const r = await post(app, 'tok')
    expect(r.status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it('валидный контекст → обработчик видит claims', async () => {
    const { app, calls } = guarded(
      true,
      {
        verifier: new FakeJwtVerifier(claims),
        billingClient: new InMemoryBillingClient({ runtimeState: fixtures.runtimeState.active() }),
      },
      'g-ok',
    )
    const r = await post(app, 'tok')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ anonymous: false, sub: 'alice' })
    expect(calls).toHaveLength(1)
  })
})

describe('jwtGuard: лог 503 без секретов', () => {
  it('токен запроса, Bearer-заголовок и JWT из сообщения ошибки вырезаны', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const secret = 'sk-live-opaque-key-123'
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhIn0.c2lnbmF0dXJl'
    const leaky = new Error(`introspection of ${secret} failed; Bearer other-token; ${jwt}`)
    const { app } = guarded(true, { verifier: throwingVerifier(leaky) }, 'g-503-redact')
    const r = await post(app, secret)
    expect(r.status).toBe(503)
    const line = String(log.mock.calls[0]?.[0])
    expect(line).toContain('introspection of [redacted] failed')
    expect(line).not.toContain(secret)
    expect(line).not.toContain('other-token')
    expect(line).not.toContain(jwt)
  })

  it('длинное сообщение обрезается', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app } = guarded(true, { verifier: throwingVerifier(new Error('x'.repeat(5000))) }, 'g-503-long')
    await post(app, 'tok')
    expect(String(log.mock.calls[0]?.[0]).length).toBeLessThan(500)
  })
})

describe('jwtGuard: исключение ниже по цепочке не перезапускает обработчик', () => {
  const okOverrides = (): AgentContextOverrides => ({
    verifier: new FakeJwtVerifier(claims),
    billingClient: new InMemoryBillingClient({ runtimeState: fixtures.runtimeState.active() }),
  })
  const req = { headers: { authorization: 'Bearer tok' }, body: {} } as unknown as Request
  const res = (): Response => {
    const r = { status: vi.fn(), json: vi.fn() }
    r.status.mockReturnValue(r)
    return r as unknown as Response
  }

  it.each([
    ['required=false, Error', false, new Error('downstream')],
    ['required=true, AuthError из downstream', true, new AuthError('downstream')],
  ])('%s → next() один раз, ошибка всплывает, ответ guard не пишет', async (_l, required, error) => {
    const guard = jwtGuard(settings(required), required, okOverrides(), 'g-next')
    const next = vi.fn(() => {
      throw error
    }) as unknown as NextFunction
    const response = res()
    await expect(guard(req, response, next)).rejects.toBe(error)
    expect(next).toHaveBeenCalledTimes(1)
    expect(response.status).not.toHaveBeenCalled()
  })
})

describe('jwtGuard, required=false (миграция) — аноним, как раньше', () => {
  it.each([
    ['BillingConfigurationError', { verifier: new FakeJwtVerifier(claims) }, 'opaque'],
    ['AuthError', { verifier: throwingVerifier(new AuthError('bad')) }, 'tok'],
    ['произвольная ошибка', { verifier: throwingVerifier(new Error('x')) }, 'tok'],
    ['нет токена', {}, undefined],
  ] as const)('%s → обработчик вызван без ctx', async (_label, overrides, bearer) => {
    const { app, calls } = guarded(false, overrides, 'g-optional')
    const r = await post(app, bearer)
    expect(r.status).toBe(200)
    expect(r.body.anonymous).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

describe('mcpChallengeGuard', () => {
  it('required + AuthError → 401 с WWW-Authenticate', async () => {
    const { app, calls } = guarded(true, {}, 'm-401', 'mcp')
    const r = await post(app)
    expect(r.status).toBe(401)
    expect(r.headers['www-authenticate']).toContain('resource_metadata=')
    expect(calls).toHaveLength(0)
  })

  it('required + BillingConfigurationError → 503 JSON-RPC, без challenge, обработчик не вызван', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { app, calls } = guarded(true, { verifier: new FakeJwtVerifier(claims) }, 'm-503', 'mcp')
    const r = await post(app, 'opaque-api-key')
    expect(r.status).toBe(503)
    expect(r.headers['www-authenticate']).toBeUndefined()
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'auth unavailable' },
      id: null,
    })
    expect(calls).toHaveLength(0)
    expect(await renderMetrics()).toMatch(
      /ai37_agent_auth_guard_errors_total\{service="m-503"\} 1/,
    )
  })

  it('required=false + сбой → аноним', async () => {
    const { app, calls } = guarded(false, { verifier: throwingVerifier(new Error('x')) }, 'm-opt', 'mcp')
    const r = await post(app, 'tok')
    expect(r.status).toBe(200)
    expect(r.body.anonymous).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

describe('createAgentHost: валидный JWT, но appsAuthToken не задан', () => {
  const card: Ai37AgentCardInput = {
    name: 'Fail Closed Agent',
    description: 'test',
    version: '0.0.0',
    url: 'http://localhost/a2a/v1',
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 's', name: 's', description: 'd', tags: [] }],
  }

  let keys: TestKeyset
  beforeAll(async () => {
    keys = await createTestKeyset()
  })

  function host(handler: AgentHandler) {
    return createAgentHost({
      card,
      handler,
      agentContext: {
        auth: {
          issuers: [{ issuer: TEST_ISSUER, audience: TEST_AUDIENCE, jwks: keys.jwks }],
          required: true,
        },
        billing: { baseUrl: 'http://localhost:9999' },
      },
    })
  }

  it('A2A и AG-UI → 503, хендлер агента не запускается', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = vi.fn<AgentHandler['run']>(async () => ({ status: 'completed', message: 'ok' }))
    const app = host({ run })
    const bearer = await keys.sign({ sub: 'alice', org_id: 'org-1', billing_org_id: 'b-org-1' })

    const a2a = await request(app)
      .post('/a2a/v1')
      .set('Authorization', `Bearer ${bearer}`)
      .send({
        jsonrpc: '2.0',
        id: '1',
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'm-1',
            role: 'user',
            parts: [{ kind: 'text', text: 'go' }],
          },
        },
      })
    expect(a2a.status).toBe(503)

    const agui = await request(app)
      .post('/agui')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ threadId: 't', runId: 'r', messages: [{ role: 'user', content: 'go' }] })
    expect(agui.status).toBe(503)

    expect(run).not.toHaveBeenCalled()
  })
})
