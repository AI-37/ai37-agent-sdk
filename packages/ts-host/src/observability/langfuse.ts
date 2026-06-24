import type { Claims } from '@ai37/agent-sdk'
import { requestScope } from '../als'
import type { Ai37Metadata } from '../types'

/**
 * Langfuse-наблюдаемость host'а: «из коробки» для любого агента на @ai37/agent-host.
 *
 * Реализация на Langfuse JS SDK v4 (OpenTelemetry). Дизайн (см. als.ts / a2a-executor.ts / agui.ts):
 *  - конфиг ТОЛЬКО из env (LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL); выключено → полный no-op;
 *  - на каждый ход executor зовёт `withTurnObservability(args, run)`: открывается turn-спан хода
 *    (`agui-turn`/`a2a-turn`, sessionId = contextId, userId = claims.sub) и делается АКТИВНЫМ
 *    OTel-контекстом на время `run()`. Поэтому `@langfuse/langchain` CallbackHandler (без `root`)
 *    автоматически вкладывает все LLM/LangGraph-спаны под turn-спан — единое дерево трейса;
 *  - кросс-сервис: turn-спан наследует входящий W3C `traceparent` (если оркестратор прокинул его в
 *    `message.metadata` через `injectTraceContext`), иначе — детерминированный trace_id из
 *    `metadata.ai37.trace_id` (фронт владеет id → может поставить score), иначе новый корень;
 *  - когниция агента прокидывает `currentLangfuseCallbacks()` в `invoke` — больше ничего знать не надо;
 *  - после хода делается `forceFlush` (важно для коротко живущих процессов/serverless).
 *
 * OTel/langfuse-пакеты грузятся ДИНАМИЧЕСКИ через `dyn()` (специфер-переменная → tsc не резолвит
 * модуль, сборка ts-host не тянет @langchain/core/@opentelemetry): отсутствие пакетов/ключей просто
 * отключает трассировку (никогда не роняет ход).
 */

/** Динамический import с НЕ-литеральным специфером — tsc не проверяет резолв, esbuild оставляет внешним. */
const dyn = (spec: string): Promise<Record<string, unknown>> =>
  import(/* @vite-ignore */ spec) as Promise<Record<string, unknown>>

/** Кешированный OTel-хэндл процесса (после первой успешной инициализации). */
interface OtelHandle {
  // @langfuse/tracing
  startActiveObservation: (
    name: string,
    fn: (span: LangfuseSpanLike) => unknown,
    opts?: Record<string, unknown>,
  ) => Promise<unknown>
  createTraceId: (seed?: string) => Promise<string>
  // @langfuse/langchain
  CallbackHandler?: new (opts?: Record<string, unknown>) => object
  // @opentelemetry/api
  context: { active: () => unknown; with: <T>(ctx: unknown, fn: () => T) => T }
  propagation: {
    inject: (ctx: unknown, carrier: Record<string, string>) => void
    extract: (ctx: unknown, carrier: Record<string, string>) => unknown
  }
  trace: { getSpan: (ctx: unknown) => { spanContext: () => { traceId: string } } | undefined }
  forceFlush: () => Promise<unknown>
}

interface LangfuseSpanLike {
  update(body: Record<string, unknown>): LangfuseSpanLike
}

// undefined = ещё не инициализировали; null = инициализировали и трассировка выключена.
//
// ВАЖНО: храним хэндл на globalThis, а НЕ в module-local `let`. Причина — tsup собирает два entry
// (`index` и `relay`) независимыми бандлами, поэтому этот файл дублируется в обоих, и module-local
// singleton получил бы ДВЕ копии. `withTurnObservability` (бандл index) инициализирует OTel, а
// `injectTraceContext` зовётся из relay/execute.ts (бандл relay) — без общего состояния он видел бы
// свою пустую копию и всегда возвращал `{}` (traceparent не уходил бы вниз → трейсы не склеивались).
const OTEL_SLOT = Symbol.for('ai37.agent-host.langfuse.otelHandle')
type OtelSlot = OtelHandle | null | undefined
const globalSlots = globalThis as unknown as Record<symbol, OtelSlot>
const getOtelHandle = (): OtelSlot => globalSlots[OTEL_SLOT]
const setOtelHandle = (v: OtelHandle | null): void => {
  globalSlots[OTEL_SLOT] = v
}

function envBool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

/** Включена ли трассировка прямо сейчас (после первой инициализации). */
export function isLangfuseEnabled(): boolean {
  return !!getOtelHandle()
}

/**
 * Ленивая инициализация OTel + LangfuseSpanProcessor из env. Идемпотентна, безопасна при ошибках.
 * Стартует NodeSDK ОДИН раз на процесс (регистрирует AsyncHooks-контекст и W3C-пропагатор).
 */
async function ensureOtel(): Promise<OtelHandle | null> {
  const cached = getOtelHandle()
  if (cached !== undefined) return cached
  const enabled = envBool(process.env.LANGFUSE_TRACING_ENABLED, true)
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  if (!enabled || !publicKey || !secretKey) {
    setOtelHandle(null)
    return null
  }
  try {
    const otelApi = await dyn('@opentelemetry/api')
    const sdkNode = await dyn('@opentelemetry/sdk-node')
    const otelMod = await dyn('@langfuse/otel')
    const tracing = await dyn('@langfuse/tracing')

    const LangfuseSpanProcessor = otelMod.LangfuseSpanProcessor as new (
      opts: Record<string, unknown>,
    ) => { forceFlush: () => Promise<unknown> }
    const processor = new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      ...(process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST
        ? { baseUrl: process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST }
        : {}),
      ...(process.env.LANGFUSE_TRACING_ENVIRONMENT
        ? { environment: process.env.LANGFUSE_TRACING_ENVIRONMENT }
        : {}),
      ...(process.env.LANGFUSE_RELEASE ? { release: process.env.LANGFUSE_RELEASE } : {}),
    })

    const NodeSDK = sdkNode.NodeSDK as new (opts: Record<string, unknown>) => { start: () => void }
    const sdk = new NodeSDK({ spanProcessors: [processor] })
    sdk.start()

    // @langfuse/langchain опционален: нет пакета/@langchain/core → LangChain-трассировки нет, но
    // turn-спаны и ручные observation'ы работают.
    let CallbackHandler: (new (opts?: Record<string, unknown>) => object) | undefined
    try {
      CallbackHandler = (await dyn('@langfuse/langchain')).CallbackHandler as new (
        opts?: Record<string, unknown>,
      ) => object
    } catch {
      CallbackHandler = undefined
    }

    const handle: OtelHandle = {
      startActiveObservation: tracing.startActiveObservation as OtelHandle['startActiveObservation'],
      createTraceId: tracing.createTraceId as OtelHandle['createTraceId'],
      CallbackHandler,
      context: otelApi.context as OtelHandle['context'],
      propagation: otelApi.propagation as OtelHandle['propagation'],
      trace: otelApi.trace as OtelHandle['trace'],
      forceFlush: () => processor.forceFlush(),
    }
    setOtelHandle(handle)
    console.info('[ai37-agent-host] Langfuse v5 (OTel) трассировка включена')
    return handle
  } catch (e) {
    console.warn(
      `[ai37-agent-host] Langfuse отключён: OTel/langfuse-пакеты не загрузились (${String(e)})`,
    )
    setOtelHandle(null)
    return null
  }
}

/** Аргументы открытия turn-спана. */
export interface BeginTurnArgs {
  contextId: string
  taskId: string
  claims?: Claims
  metadata: Ai37Metadata
  /** Имя агента/спана для UI Langfuse (по умолчанию 'agent-turn'). */
  agentName?: string
  /** Текст пользователя — кладётся во вход спана. */
  text?: string
  billingOrgId?: string
  /**
   * W3C trace-context из входящего A2A-сообщения (`{ traceparent, tracestate }`). Если есть — turn-спан
   * продолжает распределённый трейс оркестратора (нестится под его спан). Иначе используется
   * `metadata.ai37.trace_id` (фронт владеет id).
   */
  parentCarrier?: Record<string, string>
}

/** Строит `parentSpanContext` из клиентского trace_id (фронт владеет id). undefined, если id нет. */
async function parentFromTraceId(
  otel: OtelHandle,
  rawId: unknown,
): Promise<{ traceId: string; spanId: string; traceFlags: number } | undefined> {
  if (typeof rawId !== 'string' || rawId.length === 0) return undefined
  // Фронт уже шлёт валидный 32-hex OTel trace id → используем как есть (Langfuse trace id == trace_id
  // фронта, фронт может ставить score по нему). Иначе детерминированно выводим из seed.
  const traceId = /^[0-9a-f]{32}$/i.test(rawId) ? rawId.toLowerCase() : await otel.createTraceId(rawId)
  // spanId родителя не существует — нужен лишь валидный 16-hex для наследования (значение не важно).
  return { traceId, spanId: traceId.slice(0, 16), traceFlags: 1 }
}

/**
 * Открывает turn-спан хода и делает его АКТИВНЫМ OTel-контекстом на время `run()`. Внутри `run()`:
 *  - `currentLangfuseCallbacks()` отдаёт CallbackHandler → LangChain-спаны нестятся под turn-спан;
 *  - исходящие A2A-вызовы (`injectTraceContext`) форвардят `traceparent` этого спана вниз.
 * Если трассировка выключена — просто выполняет `run()` (полный no-op). `run()` ошибок не глотает —
 * пробрасывает их наружу (turn-спан при этом закрывается, батч досылается).
 */
export async function withTurnObservability<T>(
  args: BeginTurnArgs,
  run: () => Promise<T>,
  toOutput?: (result: T) => { status?: string; message?: string },
): Promise<T> {
  const otel = await ensureOtel()
  if (!otel) return run()

  const parentCtx = args.parentCarrier
    ? otel.propagation.extract(otel.context.active(), args.parentCarrier)
    : undefined
  const parentSpanContext = parentCtx ? undefined : await parentFromTraceId(otel, args.metadata.trace_id)
  const tags = [args.metadata.channel, args.metadata.app_id].filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  )

  let result!: T
  const cb = async (span: LangfuseSpanLike): Promise<void> => {
    span.update({
      ...(args.text !== undefined ? { input: { text: args.text } } : {}),
      ...(args.contextId ? { sessionId: args.contextId } : {}),
      ...(args.claims?.sub ? { userId: args.claims.sub } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      metadata: {
        taskId: args.taskId,
        contextId: args.contextId,
        channel: args.metadata.channel,
        app_id: args.metadata.app_id,
        intent: args.metadata.intent?.skill,
        billing_org_id: args.billingOrgId,
        tenant: args.metadata.tenant,
      },
    })
    // CallbackHandler без `root`: нестится под активный OTel-спан (этот turn-спан). traceId берём
    // из активного контекста — он и есть id трейса всей цепочки (для score/ручных под-спанов).
    const handler = otel.CallbackHandler ? new otel.CallbackHandler() : undefined
    const traceId = otel.trace.getSpan(otel.context.active())?.spanContext().traceId
    const scope = requestScope.getStore()
    if (scope) scope.langfuse = { ...(traceId ? { traceId } : {}), span, handler }
    result = await run()
    if (toOutput) span.update({ output: toOutput(result) })
  }

  const name = args.agentName ?? 'agent-turn'
  const opts = parentSpanContext ? { parentSpanContext } : {}
  try {
    if (parentCtx) {
      await otel.context.with(parentCtx, () => otel.startActiveObservation(name, cb, opts))
    } else {
      await otel.startActiveObservation(name, cb, opts)
    }
  } finally {
    // forceFlush ПОСЛЕ закрытия turn-спана (startActiveObservation завершил .end()) — чтобы сам
    // корневой спан попал в батч (важно для serverless/коротко живущих процессов).
    await otel.forceFlush().catch(() => {})
  }
  return result
}

/**
 * W3C trace-context текущего активного OTel-спана как carrier (`{ traceparent, tracestate? }`) для
 * проброса вниз по A2A. Sync (использует уже инициализированный хэндл хода); `{}`, если трассировка
 * выключена или ещё не инициализирована. Вызывается из relay при сборке исходящего сообщения.
 */
export function injectTraceContext(): Record<string, string> {
  const otel = getOtelHandle()
  if (!otel) return {}
  const carrier: Record<string, string> = {}
  try {
    otel.propagation.inject(otel.context.active(), carrier)
  } catch {
    /* трассировка не должна влиять на ход */
  }
  return carrier
}
