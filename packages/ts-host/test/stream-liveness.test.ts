import { afterEach, describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import type { Client } from '@a2a-js/sdk/client'
import type { ExecutionEventBus } from '@a2a-js/sdk/server'
import type { Ai37AgentCardInput as AgentCard } from '../src/index'
import { createAgentHost, type AgentHandler } from '../src/index'
import { AGUI_HEARTBEAT_MS } from '../src/agui'
import { A2A_KEEPALIVE_MS, A2aProgress } from '../src/a2a-progress'
import { executeRemoteA2a, executeRemoteA2aStreaming } from '../src/relay/index'
import { TaskState, agentMsg, statusUpdate, task, taskEvent } from './fixtures/a2a-v1'

const card: AgentCard = {
  name: 'Slow Agent',
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

function hostWith(handler: AgentHandler) {
  return createAgentHost({
    card,
    handler,
    agentContext: {
      auth: { issuer: 'https://issuer', audience: 'aud', required: false },
      billing: { baseUrl: 'http://localhost:9999' },
    },
    buildInfo: { name: 'slow-agent' },
  })
}

/** Handler, который молчит, пока тест не отпустит `release()`; `entered` — ход начался. */
function silentHandler() {
  let release!: () => void
  let markEntered!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const entered = new Promise<void>((r) => (markEntered = r))
  const handler: AgentHandler = {
    async run() {
      markEntered()
      await gate
      return { status: 'completed', message: 'готово' }
    },
  }
  return { handler, release, entered }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AG-UI heartbeat', () => {
  it('молчащий ход шлёт `: ping` раз в 15 с, после конца хода — тишина', async () => {
    // Подделываем только интервалы: сеть supertest должна идти по-настоящему.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { handler, release, entered } = silentHandler()
    const pending = request(hostWith(handler))
      .post('/agui')
      .send({ threadId: 't1', runId: 'r1', messages: [{ role: 'user', content: 'долгий вопрос' }] })
      .then((r) => r)
    await entered
    vi.advanceTimersByTime(35_000)
    release()
    const r = await pending
    expect(AGUI_HEARTBEAT_MS).toBe(15_000)
    expect(r.status).toBe(200)
    expect(r.text.match(/^: ping$/gm)?.length).toBe(2)
    expect(r.text).toContain('RUN_FINISHED')
    // Интервал снят в finally: таймеров хода не осталось.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('быстрый ход пингов не шлёт', async () => {
    const r = await request(hostWith({ run: async () => ({ status: 'completed', message: 'ок' }) }))
      .post('/agui')
      .send({ threadId: 't2', runId: 'r2', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).not.toContain(': ping')
  })
})

/** Шина-шпион: копит опубликованные события. */
function spyBus(): { bus: ExecutionEventBus; events: any[] } {
  const events: any[] = []
  const bus = { publish: (e: unknown) => events.push(e), finished: () => undefined } as unknown as ExecutionEventBus
  return { bus, events }
}

const kinds = (events: any[]) => events.map((e) => e.kind)
/** keepalive — `statusUpdate` без metadata (у node/reasoning она есть). */
const keepalives = (events: any[]) => events.filter((e) => e.kind === 'statusUpdate' && e.data.metadata === undefined)

describe('A2A keepalive (A2aProgress)', () => {
  it('молчащий ход: task working, затем status-update working без metadata каждые 20 с', () => {
    vi.useFakeTimers()
    const { bus, events } = spyBus()
    const p = new A2aProgress('t', 'c', bus)
    p.startKeepalive()
    vi.advanceTimersByTime(A2A_KEEPALIVE_MS - 1)
    expect(events).toHaveLength(0)
    vi.advanceTimersByTime(1)
    vi.advanceTimersByTime(A2A_KEEPALIVE_MS)
    expect(A2A_KEEPALIVE_MS).toBe(20_000)
    expect(kinds(events)).toEqual(['task', 'statusUpdate', 'statusUpdate'])
    for (const e of events.slice(1)) {
      expect(e.data.status.state).toBe(TaskState.TASK_STATE_WORKING)
      expect(e.data.status.message).toBeUndefined()
      expect(e.data.metadata).toBeUndefined()
    }
    expect(p.started).toBe(true)
    p.finish()
    vi.advanceTimersByTime(A2A_KEEPALIVE_MS * 3)
    expect(events).toHaveLength(3)
  })

  it('события хода переносят срок: keepalive только после 20 с тишины', () => {
    vi.useFakeTimers()
    const { bus, events } = spyBus()
    const p = new A2aProgress('t', 'c', bus)
    p.startKeepalive()
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(15_000)
      p.emit({ type: 'node', node: `шаг ${i}` })
    }
    // 5 node-событий + task; ни одного keepalive (у keepalive нет metadata).
    expect(keepalives(events)).toHaveLength(0)
    vi.advanceTimersByTime(A2A_KEEPALIVE_MS)
    expect(keepalives(events)).toHaveLength(1)
    p.stopKeepalive()
  })

  it('без startKeepalive таймеров нет', () => {
    vi.useFakeTimers()
    const { bus, events } = spyBus()
    const p = new A2aProgress('t', 'c', bus)
    p.emit({ type: 'node', node: 'x' })
    expect(vi.getTimerCount()).toBe(0)
    expect(events).toHaveLength(2)
  })
})

describe('A2A keepalive через хост (message/stream)', () => {
  it('handler молчит 45 с → в потоке два keepalive до финала', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { handler, release, entered } = silentHandler()
    const pending = request(hostWith(handler))
      .post('/a2a/v1')
      .set('A2A-Version', '0.3')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
      })
      .then((r) => r)
    await entered
    vi.advanceTimersByTime(45_000)
    release()
    const r = await pending
    const frames = r.text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5)).result)
    const pings = frames.filter(
      (f) => f?.kind === 'status-update' && f.status?.state === 'working' && !f.final && !f.metadata,
    )
    expect(pings).toHaveLength(2)
    expect(frames.at(-1)?.status?.state).toBe('completed')
  })
})

/** Стрим-клиент, который отдаёт события по расписанию (задержка перед каждым) и слушает signal. */
function scheduledStreamClient(steps: { afterMs: number; event: unknown }[]) {
  const signals: (AbortSignal | undefined)[] = []
  let closed = false
  const client = {
    sendMessageStream: (_params: unknown, options?: { signal?: AbortSignal }) => {
      signals.push(options?.signal)
      return (async function* () {
        try {
          for (const s of steps) {
            await new Promise((r) => setTimeout(r, s.afterMs))
            yield s.event
          }
        } finally {
          closed = true
        }
      })()
    },
  } as unknown as Client
  return { client, signals, closed: () => closed }
}

const done = taskEvent(task('t1', TaskState.TASK_STATE_COMPLETED, { message: agentMsg('итог') }))

describe('relay: таймер простоя и дедлайн', () => {
  it('keepalive сбрасывает таймер простоя: 3 × 50 мс тишины при idle 80 мс — не обрыв', async () => {
    const { client, signals } = scheduledStreamClient([
      { afterMs: 50, event: taskEvent(task('t1', TaskState.TASK_STATE_WORKING)) },
      { afterMs: 50, event: statusUpdate('t1', TaskState.TASK_STATE_WORKING) },
      { afterMs: 50, event: statusUpdate('t1', TaskState.TASK_STATE_WORKING) },
      { afterMs: 50, event: done },
    ])
    const seen: unknown[] = []
    const res = await executeRemoteA2aStreaming(client, { query: 'q', idleTimeoutMs: 80 }, (e) => seen.push(e))
    expect(res.state).toBe('completed')
    expect(res.text).toBe('итог')
    // keepalive без metadata наверх не поднимается: рендерить нечего.
    expect(seen).toEqual([])
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })

  it('тишина дольше idleTimeoutMs → TimeoutError, сигнал транспорта abort, генератор закрыт', async () => {
    const s = scheduledStreamClient([
      { afterMs: 10, event: taskEvent(task('t1', TaskState.TASK_STATE_WORKING)) },
      { afterMs: 500, event: done },
    ])
    const err = await executeRemoteA2aStreaming(s.client, { query: 'q', idleTimeoutMs: 60 }, () => {}).catch(
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ name: 'TimeoutError', message: 'A2A-агент молчит дольше 60 мс' })
    expect(s.signals[0]?.aborted).toBe(true)
    await new Promise((r) => setTimeout(r, 520))
    expect(s.closed()).toBe(true)
  })

  it('requestTimeoutMs ограничивает и живой стрим', async () => {
    const steps = Array.from({ length: 20 }, () => ({
      afterMs: 20,
      event: statusUpdate('t1', TaskState.TASK_STATE_WORKING),
    }))
    const s = scheduledStreamClient([{ afterMs: 0, event: taskEvent(task('t1', TaskState.TASK_STATE_WORKING)) }, ...steps])
    const err = await executeRemoteA2aStreaming(
      s.client,
      { query: 'q', idleTimeoutMs: 100, requestTimeoutMs: 150 },
      () => {},
    ).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'TimeoutError', message: 'A2A-агент не ответил за 150 мс' })
  })

  it('без таймаутов сигнал транспорту не передаётся (прежнее поведение)', async () => {
    const { client, signals } = scheduledStreamClient([{ afterMs: 0, event: done }])
    await executeRemoteA2aStreaming(client, { query: 'q' }, () => {})
    expect(signals).toEqual([undefined])
  })

  it('блокирующий вызов обрывается по requestTimeoutMs, даже если транспорт сигнал игнорирует', async () => {
    let signal: AbortSignal | undefined
    const client = {
      sendMessage: (_p: unknown, options?: { signal?: AbortSignal }) => {
        signal = options?.signal
        return new Promise(() => undefined)
      },
    } as unknown as Client
    const err = await executeRemoteA2a(client, { query: 'q', requestTimeoutMs: 50, idleTimeoutMs: 10 }).catch(
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ name: 'TimeoutError', message: 'A2A-агент не ответил за 50 мс' })
    expect(signal?.aborted).toBe(true)
  })

  it('блокирующий вызов: idleTimeoutMs не действует (событий до ответа нет)', async () => {
    const client = {
      sendMessage: () => new Promise((r) => setTimeout(() => r(task('t1', TaskState.TASK_STATE_COMPLETED)), 60)),
    } as unknown as Client
    const res = await executeRemoteA2a(client, { query: 'q', idleTimeoutMs: 10 })
    expect(res.state).toBe('completed')
  })
})
