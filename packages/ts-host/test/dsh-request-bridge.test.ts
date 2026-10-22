import { setTimeout as delay } from 'node:timers/promises'
import { request } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ScopedRequestBridge,
  type HarnessRequestContext,
  type RequestBridgeOptions,
} from '../src/dsh'

interface Context extends HarnessRequestContext {
  bearer: string
  auditId: string
}

const bridges: ScopedRequestBridge<Context>[] = []
const context = (sessionId = 'one'): Context => ({
  sessionId,
  llmKey: `model-key-${sessionId}`,
  bearer: `user-bearer-${sessionId}`,
  auditId: `audit-${sessionId}`,
  expiresAt: Infinity,
  tools: ['read_audit'],
})

async function fixture(options: Partial<RequestBridgeOptions<Context>> = {}) {
  const dispatch = vi.fn(async (ctx: Context) => ({ auditId: ctx.auditId }))
  const bridge = new ScopedRequestBridge<Context>({ timeoutMs: 10000, dispatch, ...options })
  bridges.push(bridge)
  const { url, secret } = await bridge.start()
  const bindings = new Map<string, string>()
  const bind = async (ctx: Context, signal?: AbortSignal) => {
    const binding = await bridge.bind(ctx, signal)
    bindings.set(ctx.sessionId, binding.bindingId)
    return binding
  }
  const post = (path: string, body: unknown, auth = `Bearer ${secret}`) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify(
        body && typeof body === 'object' && 'sessionId' in body
          ? { bindingId: bindings.get(String(body.sessionId)), ...body }
          : body,
      ),
    })
  return { bridge, bind, url, secret, post, dispatch }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()))
})

it('starts lazily on loopback, has stable endpoint, and closes terminally/idempotently', async () => {
  const { bridge, bind, url, secret } = await fixture()
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  expect(secret).toMatch(/^[a-f0-9]{64}$/)
  expect(await bridge.start()).toEqual({ url, secret })
  await Promise.all([bridge.close(), bridge.close()])
  await expect(bridge.start()).rejects.toThrow('closed')
  await expect(bind(context())).rejects.toThrow('closed')
})

it('does not listen as a module side effect or when closed before start', async () => {
  const bridge = new ScopedRequestBridge<Context>({ timeoutMs: 1, dispatch: vi.fn() })
  await bridge.close()
  await expect(bridge.start()).rejects.toThrow('closed')
})

it.each([0, -1, NaN, Infinity, 2 ** 31, 1.5])('rejects invalid timeout %s', (timeoutMs) => {
  expect(() => new ScopedRequestBridge({ timeoutMs, dispatch: vi.fn() })).toThrow('limit')
})

it.each([0, -1, 16_777_217, 1.5])('rejects invalid body limit %s', (maxBodyBytes) => {
  expect(
    () => new ScopedRequestBridge({ timeoutMs: 100, maxBodyBytes, dispatch: vi.fn() }),
  ).toThrow('limit')
})

it('requires the exact private secret and only permits the two POST routes', async () => {
  const { bridge, bind, post, url } = await fixture()
  await bind(context())
  for (const auth of ['', 'Bearer wrong', `Bearer ${'a'.repeat(64)}`]) {
    expect((await post('/credential', { sessionId: 'one' }, auth)).status).toBe(401)
  }
  expect((await post('/unknown', {})).status).toBe(404)
  expect((await fetch(url)).status).toBe(401)
})

it('binds credentials and capabilities to the executing session, never model arguments', async () => {
  const { bridge, bind, post, dispatch } = await fixture()
  await bind(context('one'))
  await bind(context('two'))
  const results = await Promise.all(
    ['one', 'two'].map((sessionId) => post('/credential', { sessionId }).then((r) => r.json())),
  )
  expect(results).toEqual([{ key: 'model-key-one' }, { key: 'model-key-two' }])
  const response = await post('/tool', {
    sessionId: 'two',
    name: 'read_audit',
    arguments: { auditId: 'spoofed' },
    bearer: 'spoofed',
  })
  expect(await response.json()).toEqual({ auditId: 'audit-two' })
  expect(dispatch.mock.calls[0][0]).toMatchObject({
    bearer: 'user-bearer-two',
    auditId: 'audit-two',
  })
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect((await post('/credential', { sessionId: 'unbound' })).status).toBe(403)
})

it('rejects duplicate active binding and stale release cannot revoke a later turn', async () => {
  const { bridge, bind, post } = await fixture()
  const { release } = await bind(context())
  await expect(bind(context())).rejects.toThrow('active')
  await release()
  expect((await post('/credential', { sessionId: 'one' })).status).toBe(403)
  await bind(context())
  await release()
  expect((await post('/credential', { sessionId: 'one' })).status).toBe(200)
})

it('rejects stale and missing turn nonces after a session is rebound with fresh credentials', async () => {
  const { bind, post, dispatch } = await fixture()
  const previous = await bind(context())
  expect(previous.bindingId).toMatch(/^[a-f0-9]{64}$/)
  await previous.release()
  const fresh = await bind({ ...context(), llmKey: 'rotated-key', auditId: 'next-audit' })
  expect(fresh.bindingId).not.toBe(previous.bindingId)
  for (const bindingId of [previous.bindingId, undefined, 123]) {
    expect((await post('/credential', { sessionId: 'one', bindingId })).status).toBe(403)
    expect((await post('/tool', { sessionId: 'one', bindingId, name: 'read_audit' })).status).toBe(
      403,
    )
  }
  expect(dispatch).not.toHaveBeenCalled()
  expect(await (await post('/credential', { sessionId: 'one' })).json()).toEqual({
    key: 'rotated-key',
  })
})

it('does not authorize an old request whose body completes after a session is rebound', async () => {
  const { bind, url, secret } = await fixture()
  const previous = await bind(context())
  const body = JSON.stringify({ sessionId: 'one', bindingId: previous.bindingId })
  let finish!: () => void
  const response = new Promise<number | undefined>((resolve, reject) => {
    const outgoing = request(
      `${url}/credential`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-length': Buffer.byteLength(body) },
      },
      (incoming) => {
        incoming.resume()
        incoming.on('end', () => resolve(incoming.statusCode))
      },
    )
    outgoing.on('error', reject)
    outgoing.flushHeaders()
    outgoing.write(body.slice(0, -1))
    finish = () => outgoing.end('}')
  })
  await previous.release()
  await bind({ ...context(), llmKey: 'rotated-key' })
  finish()
  expect(await response).toBe(403)
})

it.each([
  { sessionId: '' },
  { sessionId: 'x'.repeat(257) },
  { llmKey: '' },
  { expiresAt: 0 },
  { expiresAt: NaN },
  { tools: ['read_audit', 'read_audit'] },
  { tools: [''] },
])('rejects malformed verified context %j', async (patch) => {
  const { bind } = await fixture()
  await expect(bind({ ...context(), ...patch })).rejects.toThrow()
})

it('checks cancellation before binding and before each credential/tool request', async () => {
  const { bridge, bind, post, dispatch } = await fixture()
  const abort = new AbortController()
  await bind(context(), abort.signal)
  abort.abort()
  await expect(bind(context('two'), abort.signal)).rejects.toThrow()
  expect((await post('/credential', { sessionId: 'one' })).status).toBe(403)
  expect((await post('/tool', { sessionId: 'one', name: 'read_audit' })).status).toBe(403)
  expect(dispatch).not.toHaveBeenCalled()
})

it('checks current expiry even before the binding timer fires', async () => {
  const { bridge, bind, post } = await fixture()
  await bind({ ...context(), expiresAt: Date.now() + 10000 })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 20000)
  expect((await post('/credential', { sessionId: 'one' })).status).toBe(403)
})

it('caps turn lifetime, aborts in-flight work, and discards a late result', async () => {
  let signal: AbortSignal | undefined
  let finish!: (value: unknown) => void
  const { bridge, bind, post } = await fixture({
    timeoutMs: 100,
    dispatch: async (_ctx, call) => {
      signal = call.signal
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  })
  await bind(context())
  const response = post('/tool', { sessionId: 'one', name: 'read_audit' })
  await vi.waitFor(() => expect(signal).toBeDefined())
  await delay(110)
  expect(signal?.aborted).toBe(true)
  finish({ privateResult: 'must not return' })
  const result = await response
  expect(result.status).toBe(403)
  expect(await result.text()).not.toContain('privateResult')
})

it('copies the capability set, rejects unknown tools and malformed arguments', async () => {
  const { bridge, bind, post, dispatch } = await fixture()
  const tools = ['read_audit']
  await bind({ ...context(), tools })
  tools.push('confirm_facts')
  expect((await post('/tool', { sessionId: 'one', name: 'confirm_facts' })).status).toBe(403)
  for (const args of [null, [], 'x', 1]) {
    expect(
      (await post('/tool', { sessionId: 'one', name: 'read_audit', arguments: args })).status,
    ).toBe(400)
  }
  expect(dispatch).not.toHaveBeenCalled()
  expect((await post('/tool', { sessionId: 'one', name: 'read_audit' })).status).toBe(200)
})

it('rejects malformed and oversized JSON without leaking request or dispatcher errors', async () => {
  const { bridge, bind, post, url, secret } = await fixture({
    maxBodyBytes: 256,
    dispatch: async () => {
      throw new Error('PRIVATE_BEARER')
    },
  })
  await bind(context())
  for (const body of [null, [], 'x', { text: 'x'.repeat(512) }]) {
    expect((await post('/tool', body)).status).toBe(400)
  }
  const malformed = await fetch(`${url}/tool`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
    body: '{',
  })
  expect(malformed.status).toBe(400)
  const failed = await post('/tool', { sessionId: 'one', name: 'read_audit' })
  expect(failed.status).toBe(502)
  expect(await failed.text()).not.toContain('PRIVATE_BEARER')
})
