import { afterEach, describe, it, expect } from 'vitest'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentCard } from '@a2a-js/sdk'
import { OUTPUT_MODE_TEXT, OUTPUT_MODE_MARKDOWN } from '@ai37/agent-sdk'
import { createAgentHost, type AgentHandler } from '../src/index'

// Каталог A2UI этого агента (две оси: формат текста ≠ выбор каталога).
const CATALOG = 'https://ai-37.github.io/ai37-a2ui-catalog/a2ui/catalogs/ai37-a2ui/v1/catalog.json'

const card: AgentCard = {
  name: 'Test Agent',
  description: 'test',
  version: '0.0.0',
  url: 'http://localhost/a2a/v1',
  protocolVersion: '0.3',
  preferredTransport: 'JSONRPC',
  // ось каталога: агент объявляет каталог в extensions (discovery); формат текста — defaultOutputModes
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extensions: [{ uri: CATALOG, description: 'A2UI catalog', required: false }],
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: [OUTPUT_MODE_MARKDOWN, OUTPUT_MODE_TEXT],
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

/** Хелпер: A2UI capabilities в метаданных A2A-сообщения. */
function caps(ids: string[]) {
  return { a2uiClientCapabilities: { 'v0.9': { supportedCatalogIds: ids } } }
}

function app() {
  return createAgentHost({
    card,
    handler,
    catalogId: CATALOG,
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

  it('A2A без supportedCatalogIds → completed Task БЕЗ A2UI (каталог не согласован)', async () => {
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
    // каталог не согласован → компоненты не отдаются; текст (status.message) есть, т.к. агент его дал
    expect(r.body.result.artifacts[0].parts[0].data.a2ui).toEqual([])
    expect(r.body.result.status.message.parts[0].text).toBe('ok')
  })

  it('A2A с message.metadata.a2uiClientCapabilities(CATALOG) → Task С A2UI', async () => {
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
            metadata: caps([CATALOG]),
          },
        },
      })
    expect(r.status).toBe(200)
    expect(r.body.result.status.state).toBe('completed')
    expect(r.body.result.artifacts[0].parts[0].data.a2ui[0].component).toBe('SimpleTable')
  })

  it('A2A: клиент поддерживает только чужой каталог → A2UI не шлётся', async () => {
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
            metadata: caps(['https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json']),
          },
        },
      })
    expect(r.body.result.artifacts[0].parts[0].data.a2ui).toEqual([])
  })

  it('component-only: completed без message → НЕТ status.message (текст не форсится)', async () => {
    const compOnly = createAgentHost({
      card,
      handler: {
        async run() {
          return { status: 'completed', a2ui: [{ component: 'SimpleTable', props: {} }] }
        },
      },
      catalogId: CATALOG,
      agentContext: {
        auth: { issuer: 'i', audience: 'a', required: false },
        billing: { baseUrl: 'http://localhost:9999' },
      },
    })
    const r = await request(compOnly)
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
            metadata: caps([CATALOG]),
          },
        },
      })
    expect(r.body.result.status.state).toBe('completed')
    expect(r.body.result.status.message).toBeUndefined()
    expect(r.body.result.artifacts[0].parts[0].data.a2ui[0].component).toBe('SimpleTable')
  })
})

describe('A2A: emit(node/reasoning) → status-update метаданные (форвард COT сабагента)', () => {
  // Handler, который эмитит COT и возвращает финал — как elevator-calc (node-вехи пайплайна).
  const emittingHandler: AgentHandler = {
    async run({ emit }) {
      emit({ type: 'node', node: 'intent' })
      emit({ type: 'reasoning', delta: 'считаю…' })
      emit({ type: 'node', node: 'respond' })
      return { status: 'completed', message: 'готово', result: { ok: true } }
    },
  }

  function emittingApp() {
    return createAgentHost({
      card,
      handler: emittingHandler,
      agentContext: {
        auth: { issuer: 'i', audience: 'a', required: false },
        billing: { baseUrl: 'http://localhost:9999' },
      },
    })
  }

  it('message/send: финальный Task не меняется (промежуточные status-update свёрнуты)', async () => {
    const r = await request(emittingApp())
      .post('/a2a/v1')
      .send({
        jsonrpc: '2.0',
        id: '1',
        method: 'message/send',
        params: {
          message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] },
        },
      })
    expect(r.status).toBe(200)
    expect(r.body.result.kind).toBe('task')
    expect(r.body.result.status.state).toBe('completed')
    expect(r.body.result.status.message.parts[0].text).toBe('готово')
  })

  it('message/stream: SSE несёт status-update с metadata ai37/node и ai37/reasoning', async () => {
    const r = await request(emittingApp())
      .post('/a2a/v1')
      .send({
        jsonrpc: '2.0',
        id: '1',
        method: 'message/stream',
        params: {
          message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] },
        },
      })
    expect(r.status).toBe(200)
    const body = r.text
    expect(body).toContain('status-update')
    expect(body).toContain('ai37/node')
    expect(body).toContain('intent')
    expect(body).toContain('respond')
    expect(body).toContain('ai37/reasoning')
    expect(body).toContain('считаю')
    // финал тоже на месте
    expect(body).toContain('completed')
    expect(body).toContain('готово')
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
  it('дефолт (без supportedCatalogIds) → текст, БЕЗ ACTIVITY_SNAPSHOT a2ui-surface', async () => {
    const r = await request(app())
      .post('/agui')
      .send({ threadId: 't1', runId: 'r1', messages: [{ role: 'user', content: 'hi' }] })

    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toContain('text/event-stream')

    const body = r.text
    expect(body).toContain('RUN_STARTED')
    expect(body).toContain('TEXT_MESSAGE_CONTENT')
    // каталог не согласован → A2UI-поверхности нет
    expect(body).not.toContain('a2ui-surface')
    expect(body).not.toContain('SimpleTable')
    expect(body).toContain('RUN_FINISHED')
  })

  it('forwardedProps.a2uiClientCapabilities(CATALOG) → ACTIVITY_SNAPSHOT a2ui-surface с catalogId', async () => {
    const r = await request(app())
      .post('/agui')
      .send({
        threadId: 't1',
        runId: 'r1',
        messages: [{ role: 'user', content: 'hi' }],
        forwardedProps: { a2uiClientCapabilities: { 'v0.9': { supportedCatalogIds: [CATALOG] } } },
      })

    expect(r.status).toBe(200)
    const body = r.text
    expect(body).toContain('TEXT_MESSAGE_CONTENT')
    // каталог согласован → activity `a2ui-surface` с v0.9-операциями (не tool-call render_a2ui)
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

describe('AG-UI result.a2ui с конвертом A2uiSnapshot (управляемые id + dataModel)', () => {
  // Handler возвращает форму КОНВЕРТОМ через result.a2ui (путь elevator'а):
  // host сам эмитит текст ПЕРЕД формой и несёт стабильные id/dataModel в снапшот.
  const snapshotHandler: AgentHandler = {
    async run() {
      return {
        status: 'input-required' as const,
        message: 'Заполните форму',
        a2ui: [
          {
            component: { component: 'FormCard', props: { title: 'т' } },
            messageId: 'msg-stable-1',
            surfaceId: 'surf-stable-1',
            dataModel: [{ path: '/lookup/city/options', value: { options: [] } }],
          },
        ],
      }
    },
  }

  function snapshotApp() {
    return createAgentHost({
      card,
      handler: snapshotHandler,
      catalogId: CATALOG,
      agentContext: {
        auth: { issuer: 'https://issuer', audience: 'aud', required: false },
        billing: { baseUrl: 'http://localhost:9999' },
      },
      buildInfo: { name: 'test-agent' },
    })
  }

  it('AG-UI: текст ПЕРЕД формой; снапшот несёт заданные messageId/surfaceId и updateDataModel', async () => {
    const r = await request(snapshotApp())
      .post('/agui')
      .send({
        threadId: 't1',
        runId: 'r1',
        messages: [{ role: 'user', content: 'hi' }],
        forwardedProps: { a2uiClientCapabilities: { 'v0.9': { supportedCatalogIds: [CATALOG] } } },
      })

    const body = r.text
    expect(body).toContain('msg-stable-1')
    expect(body).toContain('surf-stable-1')
    expect(body).toContain('updateDataModel')
    expect(body).toContain('/lookup/city/options')
    // порядок «текст → форма»: финальный текст эмитится раньше ACTIVITY_SNAPSHOT
    expect(body.indexOf('TEXT_MESSAGE_CONTENT')).toBeLessThan(body.indexOf('ACTIVITY_SNAPSHOT'))
  })

  it('A2A: конверт уезжает в metadata.a2ui ЦЕЛИКОМ (id/dataModel — сквозной контракт)', async () => {
    const r = await request(snapshotApp())
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
            metadata: caps([CATALOG]),
          },
        },
      })
    const [item] = r.body.result.metadata.a2ui
    expect(item.component).toEqual({ component: 'FormCard', props: { title: 'т' } })
    expect(item.messageId).toBe('msg-stable-1')
    expect(item.surfaceId).toBe('surf-stable-1')
    expect(item.dataModel).toEqual([{ path: '/lookup/city/options', value: { options: [] } }])
  })
})

describe('AG-UI reasoning/COT → нативные REASONING_* (CopilotKit thinking-карточка)', () => {
  // Handler, который стримит reasoning-дельты и node-вехи через emit, затем даёт финальный текст.
  const cotHandler: AgentHandler = {
    async run({ emit }) {
      emit({ type: 'reasoning', delta: 'анализирую запрос…' })
      emit({ type: 'node', node: 'intent' })
      emit({ type: 'reasoning', delta: 'считаю по ГОСТ' })
      return { status: 'completed', message: 'готово' }
    },
  }

  function cotApp() {
    return createAgentHost({
      card,
      handler: cotHandler,
      agentContext: {
        auth: { issuer: 'https://issuer', audience: 'aud', required: false },
        billing: { baseUrl: 'http://localhost:9999' },
      },
    })
  }

  it('emit reasoning/node → REASONING_START..CONTENT..END, node влит строкой, текст после reasoning', async () => {
    const r = await request(cotApp())
      .post('/agui')
      .send({ threadId: 't1', runId: 'r1', messages: [{ role: 'user', content: 'hi' }] })

    expect(r.status).toBe(200)
    const body = r.text
    // открытие/закрытие reasoning-блока + дельты (CopilotKit рисует встроенную thinking-карточку)
    expect(body).toContain('REASONING_START')
    expect(body).toContain('REASONING_MESSAGE_START')
    expect(body).toContain('REASONING_MESSAGE_CONTENT')
    expect(body).toContain('анализирую запрос')
    expect(body).toContain('считаю по ГОСТ')
    // node влит строкой-дельтой в ту же карточку
    expect(body).toContain('intent')
    expect(body).toContain('REASONING_END')
    // финальный текст идёт ПОСЛЕ закрытия reasoning
    const reasoningEnd = body.indexOf('REASONING_END')
    const textStart = body.indexOf('TEXT_MESSAGE_START')
    expect(reasoningEnd).toBeGreaterThan(-1)
    expect(textStart).toBeGreaterThan(reasoningEnd)
    expect(body).toContain('готово')
    expect(body).toContain('RUN_FINISHED')
  })

  // Регресс: rag-factory (за sub-agent-релеем) может стримить текст ответа ЧАСТЯМИ, перемежая его
  // с reasoning (несколько раундов planner/search, ответ-генератор с interleaved cot/answer-чанками).
  // Раньше первый text-тик закрывал reasoning-блок эагерли → следующая reasoning-дельта открывала
  // ВТОРОЙ независимый REASONING-блок (id) → на клиенте две отдельные «Thinking…»-карточки на один
  // логический ход вместо одной.
  const interleavedHandler: AgentHandler = {
    async run({ emit }) {
      emit({ type: 'reasoning', delta: 'ищу документы…' })
      emit({ type: 'text', delta: 'Нашлись ' })
      emit({ type: 'reasoning', delta: 'уточняю пункт…' })
      emit({ type: 'text', delta: 'требования.' })
      return { status: 'completed' }
    },
  }

  function interleavedApp() {
    return createAgentHost({
      card,
      handler: interleavedHandler,
      agentContext: {
        auth: { issuer: 'https://issuer', audience: 'aud', required: false },
        billing: { baseUrl: 'http://localhost:9999' },
      },
    })
  }

  it('reasoning/text вперемешку в одном ходе → ОДИН REASONING-блок (не два), весь текст доставлен', async () => {
    const r = await request(interleavedApp())
      .post('/agui')
      .send({ threadId: 't1', runId: 'r1', messages: [{ role: 'user', content: 'hi' }] })

    expect(r.status).toBe(200)
    const body = r.text
    const countOccurrences = (needle: string): number => body.split(needle).length - 1
    // Ровно одна пара START — не два независимых reasoning-блока на один ход.
    expect(countOccurrences('"type":"REASONING_START"')).toBe(1)
    expect(countOccurrences('"type":"REASONING_MESSAGE_START"')).toBe(1)
    expect(countOccurrences('"type":"REASONING_END"')).toBe(1)
    expect(body).toContain('ищу документы')
    expect(body).toContain('уточняю пункт')
    // Текст из обоих text-тиков ушёл на ОДИН messageId (ensureTextStart переиспользует id).
    expect(countOccurrences('"type":"TEXT_MESSAGE_START"')).toBe(1)
    expect(body).toContain('Нашлись ')
    expect(body).toContain('требования.')
  })
})

describe('AG-UI a2uiAction (ACTIVITY_SNAPSHOT клик/submit)', () => {
  // Handler эхает input.action и input.data в текст → проверяем приём действия.
  const actionHandler: AgentHandler = {
    async run({ input }) {
      return {
        status: 'completed',
        message: `action:${JSON.stringify(input.action ?? null)} data:${JSON.stringify(input.data)}`,
        result: { action: input.action ?? null, data: input.data },
      }
    },
  }

  function actionApp() {
    return createAgentHost({
      card,
      handler: actionHandler,
      catalogId: CATALOG,
      agentContext: {
        auth: { issuer: 'https://issuer', audience: 'aud', required: false },
        billing: { baseUrl: 'http://localhost:9999' },
      },
      buildInfo: { name: 'test-agent' },
    })
  }

  it('a2uiAction.userAction{name:apply, context:{N:15}} → input.action.name=apply, context.N=15', async () => {
    const r = await request(actionApp())
      .post('/agui')
      .send({
        threadId: 't1',
        runId: 'r1',
        messages: [{ role: 'user', content: 'hi' }],
        forwardedProps: {
          a2uiAction: {
            userAction: {
              name: 'apply',
              context: { N: '15' },
              surfaceId: 'surf-1',
              sourceComponentId: 'root.children.0',
            },
          },
        },
      })

    expect(r.status).toBe(200)
    // SSE-стрим эскейпит JSON в delta (\"name\":\"apply\") — матчим экранированную форму.
    expect(r.text).toContain('action:{\\"name\\":\\"apply\\"')
    expect(r.text).toContain('\\"N\\":\\"15\\"')
    expect(r.text).toContain('\\"surfaceId\\":\\"surf-1\\"')
    expect(r.text).toContain('\\"sourceComponentId\\":\\"root.children.0\\"')
  })

  it('a2uiAction.userAction{name:nav:building, context:{}} → input.action.name=nav:building', async () => {
    const r = await request(actionApp())
      .post('/agui')
      .send({
        threadId: 't1',
        runId: 'r1',
        messages: [{ role: 'user', content: 'hi' }],
        forwardedProps: { a2uiAction: { userAction: { name: 'nav:building', context: {} } } },
      })

    expect(r.status).toBe(200)
    expect(r.text).toContain('action:{\\"name\\":\\"nav:building\\"')
    expect(r.text).toContain('\\"context\\":{}')
  })

  it('без a2uiAction → input.action undefined, input.data работает', async () => {
    const r = await request(actionApp())
      .post('/agui')
      .send({
        threadId: 't1',
        runId: 'r1',
        messages: [{ role: 'user', content: 'hi' }],
        forwardedProps: { data: { foo: 'bar' } },
      })

    expect(r.status).toBe(200)
    // action отсутствует (handler эхает null), а forwardedProps.data доходит как input.data
    expect(r.text).toContain('action:null')
    expect(r.text).toContain('\\"foo\\":\\"bar\\"')
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

describe('A2A a2uiAction (симметрия с AG-UI: оркестратор форвардит action вниз)', () => {
  // Тот же контракт, что AG-UI: action приходит метаданными сообщения → input.action.
  const actionHandler: AgentHandler = {
    async run({ input }) {
      return {
        status: 'completed',
        message: `action:${JSON.stringify(input.action ?? null)}`,
        result: { action: input.action ?? null, data: input.data },
      }
    },
  }

  function actionApp() {
    return createAgentHost({
      card,
      handler: actionHandler,
      catalogId: CATALOG,
      agentContext: {
        auth: { issuer: 'https://issuer', audience: 'aud', required: false },
        billing: { baseUrl: 'http://localhost:9999' },
      },
      buildInfo: { name: 'test-agent' },
    })
  }

  function send(metadata?: object) {
    return request(actionApp())
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
            ...(metadata ? { metadata } : {}),
          },
        },
      })
  }

  it('message.metadata.a2uiAction.userAction → input.action {name, context}', async () => {
    const r = await send({
      a2uiAction: {
        userAction: { name: 'apply', context: { N: '15' }, surfaceId: 'surf-1' },
      },
    })
    expect(r.status).toBe(200)
    const action = r.body.result.artifacts[0].parts[0].data.result.action
    expect(action.name).toBe('apply')
    expect(action.context.N).toBe('15')
    expect(action.surfaceId).toBe('surf-1')
  })

  it('nav:* действие с пустым context', async () => {
    const r = await send({ a2uiAction: { userAction: { name: 'nav:building', context: {} } } })
    expect(r.status).toBe(200)
    const action = r.body.result.artifacts[0].parts[0].data.result.action
    expect(action.name).toBe('nav:building')
    expect(action.context).toEqual({})
  })

  it('без a2uiAction → input.action undefined', async () => {
    const r = await send()
    expect(r.status).toBe(200)
    expect(r.body.result.artifacts[0].parts[0].data.result.action).toBeNull()
  })
})
