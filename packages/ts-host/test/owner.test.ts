import { beforeAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import express from 'express'
import type { Task } from '@a2a-js/sdk'
import type { ServerCallContext } from '@a2a-js/sdk/server'
import type { AgentContext } from '@ai37/agent-sdk'
import { createTestKeyset, TEST_AUDIENCE, TEST_ISSUER, type TestKeyset } from '@ai37/agent-sdk/testing'
import {
  createAgentHost,
  currentCallContext,
  currentUser,
  hostUserBuilder,
  jwtGuard,
  JwtUser,
  loadTaskState,
  requestScope,
  saveTaskState,
  type AgentHandler,
  type Ai37AgentCardInput,
  type TaskStore,
} from '../src/index'

/**
 * Стор с семантикой `@a2a-js/sdk` 1.x: задача адресуется парой (владелец, id), владелец —
 * `context.user.userName`. На 0.3 `InMemoryTaskStore` контекст игнорирует, поэтому для проверки
 * владельца нужен такой стор: так видно, что хост передаёт контекст на всех путях.
 */
class OwnerScopedStore implements TaskStore {
  readonly rows = new Map<string, Task>()
  readonly owners: string[] = []

  private key(id: string, context?: ServerCallContext): string {
    const owner = context?.user?.userName ?? '<no-context>'
    this.owners.push(owner)
    return `${owner}|${id}`
  }

  async save(task: Task, context?: ServerCallContext): Promise<void> {
    this.rows.set(this.key(task.id, context), structuredClone(task))
  }

  async load(taskId: string, context?: ServerCallContext): Promise<Task | undefined> {
    const task = this.rows.get(this.key(taskId, context))
    return task ? structuredClone(task) : undefined
  }
}

const card: Ai37AgentCardInput = {
  name: 'Owner Agent',
  description: 'test',
  version: '0.0.0',
  url: 'http://localhost/a2a/v1',
  capabilities: { streaming: true },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['text/plain'],
  skills: [{ id: 's', name: 's', description: 'd', tags: [] }],
}

// Мастер из двух шагов: первый ход спрашивает, второй видит состояние первого.
const wizard: AgentHandler = {
  async run({ input }) {
    const step = (input.taskState?.step as number | undefined) ?? 0
    if (step === 0) return { status: 'input-required', message: 'уточните', state: { step: 1 } }
    return { status: 'completed', message: `шаг ${step}`, state: { step: step + 1 } }
  },
}

let keys: TestKeyset
beforeAll(async () => {
  keys = await createTestKeyset()
})

function auth() {
  return {
    auth: {
      issuers: [{ issuer: TEST_ISSUER, audience: TEST_AUDIENCE, jwks: keys.jwks }],
      required: true,
    },
    billing: { baseUrl: 'http://localhost:9999', appsAuthToken: 'apps-test' },
  }
}

function token(sub: string, org = 'org-1'): Promise<string> {
  return keys.sign({ sub, org_id: org, billing_org_id: `b-${org}` })
}

function send(app: express.Express, bearer: string, taskId?: string) {
  return request(app)
    .post('/a2a/v1')
    .set('Authorization', `Bearer ${bearer}`)
    .send({
      jsonrpc: '2.0',
      id: '1',
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          messageId: `m-${Math.random()}`,
          role: 'user',
          parts: [{ kind: 'text', text: 'go' }],
          ...(taskId ? { taskId } : {}),
        },
      },
    })
}

function agui(app: express.Express, bearer: string, threadId: string) {
  return request(app)
    .post('/agui')
    .set('Authorization', `Bearer ${bearer}`)
    .send({ threadId, runId: 'r', messages: [{ role: 'user', content: 'go' }] })
}

describe('currentUser / currentCallContext', () => {
  const ctxWith = (claims: Record<string, unknown>) => ({ claims }) as unknown as AgentContext

  it('владелец = <org_id>:<sub> из claims хода', () => {
    requestScope.run({ ctx: ctxWith({ sub: 'u1', org_id: 'o1' }) }, () => {
      const user = currentUser()
      expect(user).toBeInstanceOf(JwtUser)
      expect(user.isAuthenticated).toBe(true)
      expect(user.userName).toBe('o1:u1')
      expect(currentCallContext().user?.userName).toBe('o1:u1')
    })
  })

  it('без org_id — пустой префикс, как у python-host', () => {
    requestScope.run({ ctx: ctxWith({ sub: 'u1' }) }, () => {
      expect(currentUser().userName).toBe(':u1')
    })
  })

  it('без sub или вне хода — аноним', () => {
    requestScope.run({ ctx: ctxWith({ org_id: 'o1' }) }, () => {
      expect(currentUser().isAuthenticated).toBe(false)
    })
    expect(currentUser().isAuthenticated).toBe(false)
    expect(currentCallContext().user?.isAuthenticated).toBe(false)
  })

  it('hostUserBuilder отдаёт того же пользователя, что currentUser', async () => {
    await requestScope.run({ ctx: ctxWith({ sub: 'u2', org_id: 'o2' }) }, async () => {
      const user = await hostUserBuilder({} as express.Request)
      expect(user.userName).toBe('o2:u2')
    })
  })
})

describe('владелец задачи на путях хоста', () => {
  it('A2A: стор получает владельца из JWT, чужой taskId не продолжить', async () => {
    const store = new OwnerScopedStore()
    const app = createAgentHost({ card, handler: wizard, agentContext: auth(), taskStore: store })
    const alice = await token('alice')
    const bob = await token('bob')

    const r1 = await send(app, alice)
    expect(r1.body.result.status.state).toBe('input-required')
    const taskId: string = r1.body.result.id
    expect(store.rows.has(`org-1:alice|${taskId}`)).toBe(true)

    // Боб знает taskId, но задача адресуется парой (владелец, id): для него её нет.
    const stolen = await send(app, bob, taskId)
    expect(stolen.body.error?.code).toBe(-32001)

    // Алиса продолжает свою паузу.
    const r2 = await send(app, alice, taskId)
    expect(r2.body.result.status.state).toBe('completed')
    expect(r2.body.result.status.message.parts[0].text).toBe('шаг 1')
    expect(store.owners).not.toContain('<no-context>')
    expect(store.owners).not.toContain('')
  })

  it('AG-UI: состояние треда видно только его владельцу', async () => {
    const store = new OwnerScopedStore()
    const app = createAgentHost({ card, handler: wizard, agentContext: auth(), taskStore: store })
    const alice = await token('alice')
    const bob = await token('bob')

    await agui(app, alice, 'th-1')
    expect(store.rows.get('org-1:alice|th-1')?.metadata?.state).toEqual({ step: 1 })

    // У Боба тот же threadId — первый ход, не продолжение мастера Алисы.
    await agui(app, bob, 'th-1')
    expect(store.rows.get('org-1:bob|th-1')?.metadata?.state).toEqual({ step: 1 })

    const second = await agui(app, alice, 'th-1')
    expect(second.text).toContain('шаг 1')
    expect(store.rows.get('org-1:alice|th-1')?.metadata?.state).toEqual({ step: 2 })
  })

  it('смена организации — другой владелец (паритет с python-host)', async () => {
    const store = new OwnerScopedStore()
    const app = createAgentHost({ card, handler: wizard, agentContext: auth(), taskStore: store })
    const r1 = await send(app, await token('alice', 'org-1'))
    const moved = await send(app, await token('alice', 'org-2'), r1.body.result.id)
    expect(moved.body.error?.code).toBe(-32001)
  })
})

describe('AG-UI-снимок без терминального статуса', () => {
  it('completed хода пишется как unknown, тред продолжается следующим ходом', async () => {
    const store = new OwnerScopedStore()
    const app = createAgentHost({ card, handler: wizard, agentContext: auth(), taskStore: store })
    const alice = await token('alice')

    await agui(app, alice, 'th-2')
    expect(store.rows.get('org-1:alice|th-2')?.status.state).toBe('input-required')

    await agui(app, alice, 'th-2')
    const snapshot = store.rows.get('org-1:alice|th-2')
    expect(snapshot?.status.state).toBe('unknown')
    expect(snapshot?.metadata?.state).toEqual({ step: 2 })

    // Третий ход того же треда видит состояние второго: снимок не «замёрз» на completed.
    const third = await agui(app, alice, 'th-2')
    expect(third.text).toContain('шаг 2')
  })
})

describe('loadTaskState / saveTaskState (REST-ручки агента)', () => {
  function restApp(store: TaskStore) {
    const app = express()
    app.use(express.json())
    const guard = jwtGuard(auth(), true)
    app.get('/state', guard, async (req, res) => {
      const state = await loadTaskState(store, String(req.query.taskId))
      if (!state) {
        res.status(404).json({ error: 'task_expired' })
        return
      }
      res.json(state)
    })
    app.post('/state', guard, async (req, res) => {
      const ok = await saveTaskState(store, String(req.query.taskId), req.body as Record<string, unknown>)
      res.status(ok ? 204 : 404).end()
    })
    return app
  }

  it('читает и заменяет состояние своей задачи, остальное в задаче не трогает', async () => {
    const store = new OwnerScopedStore()
    const host = createAgentHost({ card, handler: wizard, agentContext: auth(), taskStore: store })
    const alice = await token('alice')
    const taskId: string = (await send(host, alice)).body.result.id

    const rest = restApp(store)
    const read = await request(rest).get(`/state?taskId=${taskId}`).set('Authorization', `Bearer ${alice}`)
    expect(read.status).toBe(200)
    expect(read.body).toEqual({ step: 1 })

    const write = await request(rest)
      .post(`/state?taskId=${taskId}`)
      .set('Authorization', `Bearer ${alice}`)
      .send({ step: 1, draft: { rooms: 2 } })
    expect(write.status).toBe(204)

    const saved = store.rows.get(`org-1:alice|${taskId}`)
    expect(saved?.metadata?.state).toEqual({ step: 1, draft: { rooms: 2 } })
    expect(saved?.status.state).toBe('input-required')
    expect(saved?.metadata?.a2ui).toBeDefined()
  })

  it('чужая или несуществующая задача — 404, запись не делается', async () => {
    const store = new OwnerScopedStore()
    const host = createAgentHost({ card, handler: wizard, agentContext: auth(), taskStore: store })
    const taskId: string = (await send(host, await token('alice'))).body.result.id
    const bob = await token('bob')
    const rest = restApp(store)

    const read = await request(rest).get(`/state?taskId=${taskId}`).set('Authorization', `Bearer ${bob}`)
    expect(read.status).toBe(404)
    const write = await request(rest)
      .post(`/state?taskId=${taskId}`)
      .set('Authorization', `Bearer ${bob}`)
      .send({ hacked: true })
    expect(write.status).toBe(404)
    expect(store.rows.has(`org-1:bob|${taskId}`)).toBe(false)
    expect(store.rows.get(`org-1:alice|${taskId}`)?.metadata?.state).toEqual({ step: 1 })
  })

  it('задача без состояния — пустой словарь, а не undefined', async () => {
    const store = new OwnerScopedStore()
    const alice = await token('alice')
    const task: Task = {
      kind: 'task',
      id: 't-empty',
      contextId: 'c',
      status: { state: 'working' },
    }
    await store.save(task, { user: new JwtUser('alice', 'org-1') } as unknown as ServerCallContext)
    const read = await request(restApp(store)).get('/state?taskId=t-empty').set('Authorization', `Bearer ${alice}`)
    expect(read.status).toBe(200)
    expect(read.body).toEqual({})
  })
})
