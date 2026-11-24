import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  BillingExecutionDeniedError,
  BillingFeatureCode,
  BillingPrivilegeCode,
  billingUserMessage,
  DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE,
  type AgentContext,
} from '@ai37/agent-sdk'
import { readA2uiAppPayload, readA2uiResource } from '@ai37/a2ui-mcp-app'
import {
  a2uiApp,
  a2uiViewUri,
  buildMcpServer,
  type A2uiAppOptions,
  type A2uiStep,
} from '../src/index'

// Построитель «A2UI внутри MCP App»: всё проверяем настоящим клиентом MCP SDK поверх сервера
// хоста — так же, как форму увидит Claude.

const VIEW_BASE = 'ui://demo/a2ui-surface'
const HTML = '<!doctype html><html><body>view v2</body></html>'

type DemoState = { n: number }

const REPORT_NODE = { component: 'DemoReport', props: { title: 'Итог' } }
const EDITOR_NODE = { component: 'DemoEditor', props: { n: 1 } }

function ctxWith(
  assert: AgentContext['assertExecutionAllowed'],
): { ctx: AgentContext; assertExecutionAllowed: ReturnType<typeof vi.fn>; reportUsage: ReturnType<typeof vi.fn> } {
  const assertExecutionAllowed = vi.fn(assert)
  const reportUsage = vi.fn(async () => {})
  const ctx = { assertExecutionAllowed, reportUsage } as unknown as AgentContext
  return { ctx, assertExecutionAllowed, reportUsage }
}

const allowAll = async () =>
  ({ remainingTotalTokens: 1e9, entitlementStatus: 'active' }) as never

function options(overrides: Partial<A2uiAppOptions<DemoState>> = {}): A2uiAppOptions<DemoState> {
  return {
    viewBase: VIEW_BASE,
    html: HTML,
    surfaceId: 'demo',
    viewName: 'Форма демо-расчёта',
    open: {
      name: 'open_demo_form',
      title: 'Форма демо-расчёта',
      description: 'Открывает форму',
      inputSchema: { n: z.number().optional() },
      run: (args) => ({
        text: `Форма открыта, n=${String(args.n ?? 1)}`,
        node: EDITOR_NODE,
        state: { n: Number(args.n ?? 1) },
        calculated: false,
      }),
    },
    action: {
      name: 'demo_form_action',
      title: 'Действие формы демо',
      description: 'Служебный инструмент формы',
      run: (name, context, state): A2uiStep<DemoState> => {
        const n = Number((state as DemoState | null)?.n ?? 0)
        if (name === 'boom') throw new Error('сломалось')
        if (name === 'calc')
          return { text: `Итог: ${n * 2}`, node: REPORT_NODE, state: { n }, calculated: true }
        return { text: 'Черновик сохранён', state: { n: Number(context.n ?? n) }, calculated: false }
      },
    },
    resources: {
      recommend: (query) => ({ variants: [query.n] }),
      broken: () => {
        throw new Error('нет справочника')
      },
    },
    billing: {
      enabled: true,
      requirement: {
        feature: BillingFeatureCode.ElevatorCalcAgent,
        privilege: BillingPrivilegeCode.ElevatorCalcAllowed,
      },
      metricCode: 'demo_calls',
      totalTokens: '1000',
      skillId: (step) => `demo-${step.state.n}`,
    },
    calcActions: ['calc'],
    ...overrides,
  }
}

async function connect(
  opts: A2uiAppOptions<DemoState>,
  ctx: AgentContext | undefined,
): Promise<Client> {
  const app = await a2uiApp(opts)
  const server = await buildMcpServer(
    { name: 'demo', version: '1.0.0' },
    app.tools,
    ctx,
    app.resources,
  )
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientT)
  return client
}

function textOf(res: unknown): string {
  const blocks = ((res as { content?: unknown }).content ?? []) as Array<{
    type: string
    text?: string
  }>
  return blocks.find((b) => b.type === 'text')?.text ?? ''
}

describe('a2uiApp: набор инструментов и view', () => {
  it('форма видна модели, действие — только view; оба ведут на view с хэшем HTML', async () => {
    const client = await connect(options(), ctxWith(allowAll).ctx)
    const { tools } = await client.listTools()
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    const viewUri = a2uiViewUri(VIEW_BASE, HTML)

    expect(Object.keys(byName).sort()).toEqual(['demo_form_action', 'open_demo_form'])
    expect(byName.open_demo_form._meta).toMatchObject({ ui: { resourceUri: viewUri } })
    expect(byName.demo_form_action._meta).toMatchObject({
      ui: { resourceUri: viewUri, visibility: ['app'] },
    })
    for (const t of tools) {
      expect(t.title).toBeTruthy()
      expect(t.annotations?.readOnlyHint).toBe(true)
      // Из формы идёт расчёт с учётом: повтор — новое событие, идемпотентным его не объявляем.
      expect(t.annotations?.idempotentHint).toBeUndefined()
    }
  })

  it('адрес view несёт хэш HTML: другой HTML — другой адрес', () => {
    const uri = a2uiViewUri(VIEW_BASE, HTML)
    expect(uri).toMatch(/^ui:\/\/demo\/a2ui-surface-[0-9a-f]{12}\.html$/)
    expect(a2uiViewUri(VIEW_BASE, `${HTML} `)).not.toBe(uri)
    // Тот же адрес, что у Python-пары (sha256 от UTF-8): агенты на обоих языках совпадают.
    expect(a2uiViewUri('ui://x/a2ui-surface', 'абв')).toBe('ui://x/a2ui-surface-39e305d37ff4.html')
  })

  it('view отдаётся по текущему и по прежним адресам, в списке — только текущий', async () => {
    const client = await connect(options(), ctxWith(allowAll).ctx)
    const viewUri = a2uiViewUri(VIEW_BASE, HTML)

    const { resources } = await client.listResources()
    expect(resources.map((r) => r.uri)).toEqual([viewUri])

    for (const uri of [viewUri, `${VIEW_BASE}.html`, `${VIEW_BASE}-ee8593734650.html`]) {
      const read = await client.readResource({ uri })
      expect(read.contents[0]).toMatchObject({ uri, text: HTML })
    }
    await expect(client.readResource({ uri: 'ui://demo/other.html' })).rejects.toThrow()
    await expect(client.readResource({ uri: `${VIEW_BASE}-x/y.html` })).rejects.toThrow()
  })
})

describe('a2uiApp: ход формы и учёт', () => {
  it('открытие: поверхность в _meta, доступ проверен, учёта нет', async () => {
    const { ctx, assertExecutionAllowed, reportUsage } = ctxWith(allowAll)
    const client = await connect(options(), ctx)
    const res = await client.callTool({ name: 'open_demo_form', arguments: { n: 3 } })

    const payload = readA2uiAppPayload(res._meta)
    expect(textOf(res)).toBe('Форма открыта, n=3')
    expect(payload).toMatchObject({ surfaceId: 'demo', actionTool: 'demo_form_action', state: { n: 3 } })
    expect(JSON.stringify(payload?.messages)).toContain('DemoEditor')
    expect(assertExecutionAllowed).toHaveBeenCalledWith({
      feature: BillingFeatureCode.ElevatorCalcAgent,
      privilege: BillingPrivilegeCode.ElevatorCalcAllowed,
    })
    expect(reportUsage).not.toHaveBeenCalled()
  })

  it('расчёт: проверка доступа и ровно одно событие учёта со skill_id агента', async () => {
    const { ctx, assertExecutionAllowed, reportUsage } = ctxWith(allowAll)
    const client = await connect(options(), ctx)
    const res = await client.callTool({
      name: 'demo_form_action',
      arguments: { name: 'calc', context: {}, state: { n: 4 } },
    })

    expect(textOf(res)).toBe('Итог: 8')
    expect(JSON.stringify(readA2uiAppPayload(res._meta)?.messages)).toContain('DemoReport')
    expect(assertExecutionAllowed).toHaveBeenCalledTimes(1)
    expect(reportUsage).toHaveBeenCalledTimes(1)
    expect(reportUsage.mock.calls[0]?.[0]).toMatchObject({
      code: 'demo_calls',
      properties: { skill_id: 'demo-4', total_tokens: '1000' },
    })
  })

  it('черновик: пустой поток, без проверки доступа и без учёта', async () => {
    const { ctx, assertExecutionAllowed, reportUsage } = ctxWith(allowAll)
    const client = await connect(options(), ctx)
    const res = await client.callTool({
      name: 'demo_form_action',
      arguments: { name: 'draft', context: { n: 7 }, state: { n: 1 } },
    })

    const payload = readA2uiAppPayload(res._meta)
    expect(payload?.messages).toEqual([])
    expect(payload?.state).toEqual({ n: 7 })
    expect(assertExecutionAllowed).not.toHaveBeenCalled()
    expect(reportUsage).not.toHaveBeenCalled()
  })

  it('resource:<id> — тело ресурса; неизвестный id и исключение — пустой ресурс', async () => {
    const { ctx, assertExecutionAllowed } = ctxWith(allowAll)
    const client = await connect(options(), ctx)
    const call = (name: string) =>
      client.callTool({ name: 'demo_form_action', arguments: { name, context: { n: '5' } } })

    expect(readA2uiResource((await call('resource:recommend'))._meta)).toEqual({ variants: ['5'] })
    expect(readA2uiResource((await call('resource:nope'))._meta)).toBeUndefined()
    expect(readA2uiResource((await call('resource:broken'))._meta)).toBeUndefined()
    expect(assertExecutionAllowed).not.toHaveBeenCalled()
  })

  it('исключение в ходе — isError с текстом, сервер жив', async () => {
    const client = await connect(options(), ctxWith(allowAll).ctx)
    const res = await client.callTool({
      name: 'demo_form_action',
      arguments: { name: 'boom', context: {}, state: {} },
    })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('сломалось')
    const next = await client.callTool({ name: 'open_demo_form', arguments: {} })
    expect(next.isError).toBeFalsy()
  })
})

describe('a2uiApp: отказ биллинга', () => {
  const denied = (reason: string) =>
    Object.assign(Object.create(BillingExecutionDeniedError.prototype) as Error, {
      reason,
      message: `BILLING_DENIED[${reason}]: деталь`,
    })

  const cases: Array<[string, AgentContext['assertExecutionAllowed'], string]> = [
    [
      'нет фичи',
      async () => {
        throw denied('MISSING_FEATURE')
      },
      billingUserMessage('MISSING_FEATURE', 'ru'),
    ],
    [
      'платёж не прошёл',
      async () => {
        throw denied('PAYMENT_FAILED')
      },
      billingUserMessage('PAYMENT_FAILED', 'ru'),
    ],
    [
      'токенов не больше порога',
      async () => ({ remainingTotalTokens: 10, entitlementStatus: 'active' }) as never,
      billingUserMessage('NO_TOKENS', 'ru'),
    ],
  ]

  it.each(cases)('%s → isError без _meta, понятный текст', async (_, assert, expected) => {
    const { ctx, reportUsage } = ctxWith(assert)
    const client = await connect(
      options({ billing: { ...options().billing, minTokens: 10 } }),
      ctx,
    )
    const res = await client.callTool({
      name: 'demo_form_action',
      arguments: { name: 'calc', context: {}, state: { n: 1 } },
    })
    expect(res.isError).toBe(true)
    expect(res._meta).toBeUndefined()
    expect(textOf(res)).toBe(expected)
    expect(textOf(res)).not.toContain('BILLING_DENIED')
    expect(reportUsage).not.toHaveBeenCalled()
  })

  it('нет ctx при включённом биллинге → общий текст отказа', async () => {
    const client = await connect(options(), undefined)
    const res = await client.callTool({ name: 'open_demo_form', arguments: {} })
    expect(res.isError).toBe(true)
    expect(res._meta).toBeUndefined()
    expect(textOf(res)).toBe(DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE.ru)
  })

  it('биллинг выключен — ни проверки, ни учёта', async () => {
    const { ctx, assertExecutionAllowed, reportUsage } = ctxWith(allowAll)
    const client = await connect(
      options({ billing: { ...options().billing, enabled: false } }),
      ctx,
    )
    const res = await client.callTool({
      name: 'demo_form_action',
      arguments: { name: 'calc', context: {}, state: { n: 2 } },
    })
    expect(res.isError).toBeFalsy()
    expect(assertExecutionAllowed).not.toHaveBeenCalled()
    expect(reportUsage).not.toHaveBeenCalled()
  })

  it('сбой учёта не ломает посчитанный ответ', async () => {
    const { ctx, reportUsage } = ctxWith(allowAll)
    reportUsage.mockRejectedValueOnce(new Error('billing down'))
    const client = await connect(options(), ctx)
    const res = await client.callTool({
      name: 'demo_form_action',
      arguments: { name: 'calc', context: {}, state: { n: 2 } },
    })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toBe('Итог: 4')
  })
})
