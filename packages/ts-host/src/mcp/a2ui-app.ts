import { createHash, randomUUID } from 'node:crypto'
import type { ZodRawShape } from 'zod'
import {
  billingUserMessage,
  DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE,
  friendlyBillingMessage,
  t,
  type AgentContext,
  type BillingExecutionRequirement,
} from '@ai37/agent-sdk'
import { currentLocale } from '../als'
import type { McpResourceDef, McpToolDef, McpToolResult } from './types'

/**
 * Построитель «A2UI внутри MCP App» (plans/mcp-apps-agent-host-keo-thermal.md, срез 1).
 *
 * Агент даёт чистые функции хода формы, построитель — всё, что про транспорт: инструмент формы,
 * app-only инструмент действий, ресурс view, ресурсный канал `resource:<id>`, проверку доступа и
 * учёт. Так у всех агентов один текст отказа, один формат события учёта и одно правило адреса view.
 * Протокол `_meta["ai37/a2ui"]` собирают помощники `@ai37/a2ui-mcp-app` — пакет подгружается
 * динамически (optional peer), его берёт агент вместе с HTML view.
 */

/** Узел каталога, как его собирает агент: имя компонента и его props. */
export interface A2uiAppNode {
  component: string
  props: Record<string, unknown>
}

/** Один ход формы: текст для модели, узел для view, новое состояние документа. */
export interface A2uiStep<S = unknown> {
  /** Самодостаточный текст для модели и хоста без UI. JSON формы сюда не кладут. */
  text: string
  /** Узел каталога; нет у черновика — поверхность во view не пересоздаётся. */
  node?: A2uiAppNode
  /** Исходные данные документа: view вернёт их в следующем действии. */
  state: S
  /** Выполнен расчёт — единственный ход, который учитывается в биллинге. */
  calculated: boolean
  /** Полный протокол: его отдают структурные инструменты агента, форме он не нужен. */
  report?: string
}

type MaybePromise<T> = T | Promise<T>

/** Учёт и проверка доступа MCP-пути агента — те же, что у его A2A-пути. */
export interface A2uiAppBilling<S = unknown> {
  /** Выключен — ни проверки, ни учёта (локальный запуск, агент без тарифа). */
  enabled: boolean
  requirement: BillingExecutionRequirement
  /** Остаток токенов `≤ minTokens` — отказ «нет ресурсов». По умолчанию 0. */
  minTokens?: number
  /** `BILLING_METRIC_CODE` агента. */
  metricCode: string
  /** `properties.total_tokens` события, если агент его шлёт. */
  totalTokens?: number
  /** `skill_id` события — тот же, что у структурного инструмента: для учёта это один расчёт. */
  skillId: (step: A2uiStep<S>) => string
}

/** Проверка доступа и учёт по правилам построителя — для структурных инструментов агента. */
export interface McpBilling {
  /** Отказ готовым результатом (`isError`, текст для человека) или `undefined`. */
  check: (ctx: AgentContext | undefined) => Promise<McpToolResult | undefined>
  /** Одно событие учёта, best-effort: сбой биллинга не ломает посчитанный ответ. */
  meter: (ctx: AgentContext | undefined, skillId: string) => Promise<void>
}

export interface A2uiAppOptions<S = unknown> {
  /** `ui://<агент>/a2ui-surface`: адрес view построитель дописывает хэшем HTML. */
  viewBase: string
  /** HTML view — `A2UI_MCP_APP_HTML` из `@ai37/a2ui-mcp-app`. */
  html: string
  surfaceId: string
  /** Название ресурса view в `resources/list`. */
  viewName?: string
  open: {
    name: string
    title: string
    description: string
    inputSchema: ZodRawShape
    run: (
      args: Record<string, unknown>,
      ctx: AgentContext | undefined,
    ) => MaybePromise<A2uiStep<S>>
  }
  action: {
    name: string
    title: string
    description: string
    run: (
      name: string,
      context: Record<string, unknown>,
      state: unknown,
      ctx: AgentContext | undefined,
    ) => MaybePromise<A2uiStep<S>>
  }
  /** `resource:<id>` → тело, которое отдала бы ручка `/api/agent-resource`. */
  resources?: Record<
    string,
    (
      query: Record<string, unknown>,
      ctx: AgentContext | undefined,
    ) => MaybePromise<unknown>
  >
  billing: A2uiAppBilling<S>
  /** Действия, после которых идёт расчёт: только перед ними проверяется доступ. */
  calcActions: string[]
}

export interface A2uiApp {
  tools: McpToolDef[]
  resources: McpResourceDef[]
  /** Адрес view с хэшем — им же помечают свои структурные инструменты (`ui.resourceUri`). */
  viewUri: string
  billing: McpBilling
}

/** `${viewBase}-${sha256(html)[:12]}.html`: новый HTML — новый адрес, кэш хоста не держит старый. */
export function a2uiViewUri(viewBase: string, html: string): string {
  const hash = createHash('sha256').update(html).digest('hex').slice(0, 12)
  return `${viewBase}-${hash}.html`
}

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], isError }
}

/**
 * Проверка доступа и учёт MCP-пути. Тексты отказа — из `@ai37/agent-sdk` на языке хода:
 * пользователь внешнего хоста видит понятное «нет доступа» или «закончились токены», а не
 * технический код `BILLING_DENIED: …`.
 */
export function mcpBilling(billing: Omit<A2uiAppBilling, 'skillId'>): McpBilling {
  const minTokens = billing.minTokens ?? 0

  const check = async (
    ctx: AgentContext | undefined,
  ): Promise<McpToolResult | undefined> => {
    if (!billing.enabled) return undefined
    const locale = currentLocale()
    if (!ctx) return textResult(t(locale, DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE), true)
    try {
      const state = await ctx.assertExecutionAllowed(billing.requirement)
      if (state.remainingTotalTokens <= minTokens)
        return textResult(billingUserMessage('NO_TOKENS', locale), true)
      return undefined
    } catch (e) {
      return textResult(friendlyBillingMessage(e, locale), true)
    }
  }

  const meter = async (
    ctx: AgentContext | undefined,
    skillId: string,
  ): Promise<void> => {
    if (!billing.enabled || !ctx) return
    try {
      await ctx.reportUsage({
        transactionId: randomUUID(),
        code: billing.metricCode,
        properties: {
          skill_id: skillId,
          ...(billing.totalTokens !== undefined
            ? { total_tokens: billing.totalTokens }
            : {}),
        },
      })
    } catch {
      // учёт best-effort: ответ уже посчитан
    }
  }

  return { check, meter }
}

type A2uiMcpAppModule = typeof import('@ai37/a2ui-mcp-app')

/** `@ai37/a2ui-mcp-app` — optional peer: агенту без MCP App он не нужен. */
async function loadA2uiMcpApp(): Promise<A2uiMcpAppModule> {
  try {
    return await import('@ai37/a2ui-mcp-app')
  } catch {
    throw new Error(
      'a2uiApp: нужен пакет @ai37/a2ui-mcp-app (npm i @ai37/a2ui-mcp-app) — он собирает поток A2UI для view',
    )
  }
}

/** Текст исключения хода — модели и view, без падения процесса. */
function failure(e: unknown): McpToolResult {
  return textResult(`Ошибка: ${e instanceof Error ? e.message : String(e)}`, true)
}

/** Аргументы app-only инструмента: действие поверхности, его контекст и состояние документа. */
async function actionShape(): Promise<ZodRawShape> {
  const { z } = await import('zod')
  return {
    name: z.string().describe('Имя действия поверхности'),
    context: z.record(z.string(), z.unknown()).default({}),
    state: z.unknown().optional(),
  }
}

/**
 * Собирает инструмент формы, app-only инструмент действий и ресурс view. Ресурс отвечает и на
 * прежние адреса `${viewBase}<хвост>`: хост кэширует `tools/list`, и после выхода нового HTML
 * спрашивает форму по старому адресу — без этого он получил бы «Resource not found».
 */
export async function a2uiApp<S>(opts: A2uiAppOptions<S>): Promise<A2uiApp> {
  const viewUri = a2uiViewUri(opts.viewBase, opts.html)
  const billing = mcpBilling(opts.billing)
  const calcActions = new Set(opts.calcActions)
  const { a2uiAppResult, a2uiResourceResult, parseResourceActionName } =
    await loadA2uiMcpApp()

  const stepResult = (step: A2uiStep<S>): McpToolResult => {
    const base = {
      text: step.text,
      surfaceId: opts.surfaceId,
      actionTool: opts.action.name,
      state: step.state,
    }
    return step.node
      ? a2uiAppResult({ ...base, node: step.node })
      : a2uiAppResult({ ...base, messages: [] })
  }

  /** Ход, который может быть расчётом: учёт — ровно одно событие на выполненный расчёт. */
  const runStep = async (
    run: () => MaybePromise<A2uiStep<S>>,
    ctx: AgentContext | undefined,
  ): Promise<McpToolResult> => {
    let step: A2uiStep<S>
    try {
      step = await run()
    } catch (e) {
      return failure(e)
    }
    if (step.calculated) await billing.meter(ctx, opts.billing.skillId(step))
    return stepResult(step)
  }

  const resourceResult = async (
    id: string,
    query: Record<string, unknown>,
    ctx: AgentContext | undefined,
  ): Promise<McpToolResult> => {
    const read = opts.resources?.[id]
    if (!read) return a2uiResourceResult(undefined)
    try {
      return a2uiResourceResult(await read(query, ctx))
    } catch {
      // view отдаст блоку 404 — как ручка ресурса на ошибку
      return a2uiResourceResult(undefined)
    }
  }

  const openTool: McpToolDef = {
    name: opts.open.name,
    title: opts.open.title,
    description: opts.open.description,
    // Без idempotentHint: из формы идёт расчёт с учётом, повтор — новое событие.
    annotations: { readOnlyHint: true },
    inputSchema: opts.open.inputSchema,
    ui: { resourceUri: viewUri },
    handler: async (args, ctx) => {
      const deny = await billing.check(ctx)
      if (deny) return deny
      return runStep(() => opts.open.run(args, ctx), ctx)
    },
  }

  const actionTool: McpToolDef = {
    name: opts.action.name,
    title: opts.action.title,
    description: opts.action.description,
    annotations: { readOnlyHint: true },
    inputSchema: await actionShape(),
    ui: { resourceUri: viewUri, visibility: ['app'] },
    handler: async (args, ctx) => {
      const name = String(args.name ?? '')
      const context = (args.context ?? {}) as Record<string, unknown>
      const resourceId = parseResourceActionName(name)
      if (resourceId !== undefined) return resourceResult(resourceId, context, ctx)
      // Черновик, навигация и подбор шлются часто и ничего не стоят — медленный /state не дёргаем.
      if (calcActions.has(name)) {
        const deny = await billing.check(ctx)
        if (deny) return deny
      }
      return runStep(() => opts.action.run(name, context, args.state, ctx), ctx)
    },
  }

  const view: McpResourceDef = {
    uri: viewUri,
    uriPrefix: opts.viewBase,
    name: opts.viewName ?? 'Форма и отчёт расчёта',
    description: 'Поверхность каталога A2UI AI37 внутри MCP App',
    read: () => opts.html,
    ui: { prefersBorder: true },
  }

  return { tools: [openTool, actionTool], resources: [view], viewUri, billing }
}
