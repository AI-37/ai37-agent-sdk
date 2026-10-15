import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Client } from '@a2a-js/sdk/client'
import type { Ai37AgentCardInput as AgentCard } from '../src/index'
import { createAgentHost, type AgentHandler, type AgentRequest } from '../src/index'
import { bridgeHandlerToMcpTool } from '../src/mcp/bridge'
import { executeRemoteA2a, executeRemoteA2aStreaming } from '../src/relay/index'
import { TaskState, statusUpdate, task, taskEvent } from './fixtures/a2a-v1'

const card: AgentCard = {
  name: 'Cancel Agent',
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
    buildInfo: { name: 'cancel-agent' },
  })
}

/** Handler, который ждёт отмены (или `finish()`), и запоминает, что увидел. */
function waitingHandler(finishWith: 'completed' | 'failed' = 'failed') {
  const seen: { req?: AgentRequest; abortedReason?: unknown } = {}
  let entered!: () => void
  let finish!: () => void
  const enteredP = new Promise<void>((r) => (entered = r))
  const finishP = new Promise<void>((r) => (finish = r))
  const handler: AgentHandler = {
    async run(req) {
      seen.req = req
      // Первое событие публикует задачу: по нему relay и узнаёт id, который потом отменяет.
      req.emit({ type: 'node', node: 'старт' })
      await new Promise((r) => setTimeout(r, 30))
      entered()
      await Promise.race([
        finishP,
        new Promise<void>((r) => {
          req.signal?.addEventListener('abort', () => {
            seen.abortedReason = req.signal?.reason
            r()
          })
        }),
      ])
      return { status: finishWith, message: 'итог хода' }
    },
  }
  return { handler, seen, entered: enteredP, finish }
}

describe('AG-UI: закрытие потока клиентом отменяет ход', () => {
  it('клиент оборвал соединение → AgentRequest.signal abort с AbortError', async () => {
    const { handler, seen, entered } = waitingHandler()
    const server: Server = hostWith(handler).listen(0)
    const { port } = server.address() as AddressInfo
    const body = JSON.stringify({ threadId: 't', runId: 'r', messages: [{ role: 'user', content: 'hi' }] })
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/agui',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    })
    req.on('error', () => undefined)
    req.end(body)
    await entered
    expect(seen.req?.signal?.aborted).toBe(false)
    req.destroy()
    await new Promise((r) => setTimeout(r, 100))
    expect(seen.req?.signal?.aborted).toBe(true)
    expect(seen.abortedReason).toMatchObject({ name: 'AbortError' })
    server.close()
  })

  it('ход, дошедший до конца, сигнал не трогает', async () => {
    let signal: AbortSignal | undefined
    const r = await request(
      hostWith({
        run: async (req) => {
          signal = req.signal
          return { status: 'completed', message: 'ок' }
        },
      }),
    )
      .post('/agui')
      .send({ threadId: 't2', runId: 'r2', messages: [{ role: 'user', content: 'hi' }] })
    expect(r.text).toContain('RUN_FINISHED')
    expect(signal?.aborted).toBe(false)
  })
})

const streamCall = {
  jsonrpc: '2.0',
  id: 1,
  method: 'message/stream',
  params: { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
}

function frames(text: string): any[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)).result)
}

describe('A2A tasks/cancel', () => {
  it('отменяет идущий ход: сигнал handler’у, задача canceled, итог handler’а не публикуется', async () => {
    const { handler, seen, entered } = waitingHandler('failed')
    const app = hostWith(handler)
    const stream = request(app).post('/a2a/v1').set('A2A-Version', '0.3').send(streamCall).then((r) => r)
    await entered
    const taskId = seen.req!.input.taskId
    const cancel = await request(app)
      .post('/a2a/v1')
      .set('A2A-Version', '0.3')
      .send({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { id: taskId } })
    expect(cancel.body.error).toBeUndefined()
    expect(cancel.body.result.status.state).toBe('canceled')
    expect(seen.abortedReason).toMatchObject({ name: 'AbortError' })
    const last = frames((await stream).text).at(-1)
    expect(last?.status?.state).toBe('canceled')
    // Повторная отмена уже отменённой задачи — та же задача, без ошибки.
    const again = await request(app)
      .post('/a2a/v1')
      .set('A2A-Version', '0.3')
      .send({ jsonrpc: '2.0', id: 3, method: 'tasks/cancel', params: { id: taskId } })
    expect(again.body.result.status.state).toBe('canceled')
  })

  it('handler, проигнорировавший сигнал, отмену не перезаписывает', async () => {
    const { handler, seen, entered, finish } = waitingHandler('completed')
    // Этот handler не слушает сигнал: завершится только по finish().
    const deaf: AgentHandler = { run: (req) => handler.run({ ...req, signal: undefined }) }
    const app = hostWith(deaf)
    const stream = request(app).post('/a2a/v1').set('A2A-Version', '0.3').send(streamCall).then((r) => r)
    await entered
    const taskId = seen.req!.input.taskId
    const cancel = await request(app)
      .post('/a2a/v1')
      .set('A2A-Version', '0.3')
      .send({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { id: taskId } })
    expect(cancel.body.result.status.state).toBe('canceled')
    finish()
    await stream
    await new Promise((r) => setTimeout(r, 50))
    const got = await request(app)
      .post('/a2a/v1')
      .set('A2A-Version', '0.3')
      .send({ jsonrpc: '2.0', id: 4, method: 'tasks/get', params: { id: taskId } })
    expect(got.body.result.status.state).toBe('canceled')
  })
})

describe('MCP-мост: отмена вызова доходит до handler', () => {
  it('signal из MCP передаётся в AgentRequest', async () => {
    let got: AbortSignal | undefined
    const tool = bridgeHandlerToMcpTool(
      {
        run: async (req) => {
          got = req.signal
          return { status: 'completed', message: 'ок' }
        },
      },
      { name: 't', title: 'T', description: 'd' },
    )
    const ac = new AbortController()
    await tool.handler({ query: 'q' }, undefined, ac.signal)
    expect(got).toBe(ac.signal)
  })
})

describe('relay: отмена вызова', () => {
  function cancellableStream() {
    const cancels: unknown[] = []
    const client = {
      sendMessageStream: (_p: unknown, options?: { signal?: AbortSignal }) =>
        (async function* () {
          yield taskEvent(task('child-1', TaskState.TASK_STATE_WORKING))
          for (;;) {
            await new Promise((r) => setTimeout(r, 20))
            if (options?.signal?.aborted) return
            yield statusUpdate('child-1', TaskState.TASK_STATE_WORKING)
          }
        })(),
      sendMessage: (_p: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason))),
      cancelTask: (params: unknown) => {
        cancels.push(params)
        return Promise.resolve(task('child-1', TaskState.TASK_STATE_CANCELED))
      },
    } as unknown as Client
    return { client, cancels }
  }

  it('abort сигнала посреди стрима → ошибка с причиной отмены и tasks/cancel по id задачи', async () => {
    const { client, cancels } = cancellableStream()
    const ac = new AbortController()
    setTimeout(() => ac.abort(new DOMException('ход отменён', 'AbortError')), 70)
    const err = await executeRemoteA2aStreaming(client, { query: 'q', signal: ac.signal }, () => {}).catch(
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ name: 'AbortError', message: 'ход отменён' })
    await new Promise((r) => setTimeout(r, 10))
    expect(cancels).toEqual([{ tenant: '', id: 'child-1', metadata: undefined }])
  })

  it('таймер простоя тоже отменяет задачу у агента', async () => {
    const cancels: unknown[] = []
    const client = {
      sendMessageStream: () =>
        (async function* () {
          yield taskEvent(task('child-2', TaskState.TASK_STATE_WORKING))
          await new Promise((r) => setTimeout(r, 500))
        })(),
      cancelTask: (params: unknown) => {
        cancels.push(params)
        return Promise.reject(new Error('старый хост: no-op'))
      },
    } as unknown as Client
    const err = await executeRemoteA2aStreaming(client, { query: 'q', idleTimeoutMs: 40 }, () => {}).catch(
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ name: 'TimeoutError' })
    await new Promise((r) => setTimeout(r, 10))
    expect(cancels).toEqual([{ tenant: '', id: 'child-2', metadata: undefined }])
  })

  it('блокирующий resume-вызов: отмена шлёт tasks/cancel по resumeTaskId', async () => {
    const { client, cancels } = cancellableStream()
    const ac = new AbortController()
    setTimeout(() => ac.abort(new DOMException('стоп', 'AbortError')), 30)
    const err = await executeRemoteA2a(client, { query: 'q', resumeTaskId: 'child-9', signal: ac.signal }).catch(
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ name: 'AbortError' })
    await new Promise((r) => setTimeout(r, 10))
    expect(cancels).toEqual([{ tenant: '', id: 'child-9', metadata: undefined }])
  })

  it('уже отменённый сигнал — вызова не происходит', async () => {
    const { client } = cancellableStream()
    const ac = new AbortController()
    ac.abort(new DOMException('раньше', 'AbortError'))
    await expect(executeRemoteA2a(client, { query: 'q', signal: ac.signal })).rejects.toMatchObject({
      message: 'раньше',
    })
  })
})
