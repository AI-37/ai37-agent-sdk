import { randomUUID } from 'node:crypto'
import type { Claims } from '@ai37/agent-sdk'
import { requestScope, type HostLangfuseScope } from '../als'
import type { Ai37Metadata } from '../types'

/**
 * Langfuse-наблюдаемость host'а: «из коробки» для любого агента на @ai37/agent-host.
 *
 * Дизайн (см. als.ts / a2a-executor.ts / agui.ts):
 *  - конфиг ТОЛЬКО из env (LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL); выключено → полный no-op;
 *  - на каждый ход executor зовёт `beginTurnObservability` ДО handler.run: создаётся корневой трейс
 *    (sessionId = contextId, userId = claims.sub) и LangChain `CallbackHandler`, привязанный к нему;
 *  - id трейса берётся из `metadata.ai37.trace_id` клиента (фронт владеет им → может поставить score),
 *    иначе генерируется;
 *  - когниция агента прокидывает `currentLangfuseCallbacks()` в `invoke` — больше ничего знать не надо;
 *  - после хода `flushTurnObservability` досылает батч (важно для коротко живущих процессов/serverless).
 *
 * `langfuse` и `langfuse-langchain` грузятся ДИНАМИЧЕСКИ: ts-host не тянет @langchain/core в сборку,
 * а отсутствие пакетов/ключей просто отключает трассировку (никогда не роняет ход).
 */

// --- Минимальные структурные типы (чтобы не зависеть от типов langfuse при сборке ts-host). ---
interface LangfuseTraceClientLike {
  id: string
  update(body: Record<string, unknown>): unknown
}
interface LangfuseClientLike {
  trace(body: Record<string, unknown>): LangfuseTraceClientLike
  flushAsync(): Promise<unknown>
  shutdownAsync?(): Promise<unknown>
}
type LangchainCallbackLike = object

/** Результат `beginTurnObservability`. */
export interface TurnObservability extends HostLangfuseScope {
  traceId: string
  trace: LangfuseTraceClientLike
  handler?: LangchainCallbackLike
}

// undefined = ещё не инициализировали; null = инициализировали и трассировка выключена.
let clientSingleton: LangfuseClientLike | null | undefined

function envBool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

/** Включена ли трассировка прямо сейчас (после первой инициализации клиента). */
export function isLangfuseEnabled(): boolean {
  return !!clientSingleton
}

/** Ленивая инициализация singleton-клиента из env. Идемпотентна, безопасна при ошибках. */
async function getClient(): Promise<LangfuseClientLike | null> {
  if (clientSingleton !== undefined) return clientSingleton
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY
  const secretKey = process.env.LANGFUSE_SECRET_KEY
  const enabled = envBool(process.env.LANGFUSE_TRACING_ENABLED, true)
  if (!enabled || !publicKey || !secretKey) {
    clientSingleton = null
    return null
  }
  try {
    const mod = (await import('langfuse')) as {
      Langfuse: new (opts: Record<string, unknown>) => LangfuseClientLike
    }
    clientSingleton = new mod.Langfuse({
      publicKey,
      secretKey,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST,
      ...(process.env.LANGFUSE_TRACING_ENVIRONMENT
        ? { environment: process.env.LANGFUSE_TRACING_ENVIRONMENT }
        : {}),
      ...(process.env.LANGFUSE_RELEASE ? { release: process.env.LANGFUSE_RELEASE } : {}),
    })
    console.info('[ai37-agent-host] Langfuse-трассировка включена')
  } catch (e) {
    console.warn(
      `[ai37-agent-host] Langfuse отключён: пакет 'langfuse' не загрузился (${String(e)})`,
    )
    clientSingleton = null
  }
  return clientSingleton
}

/** Строит LangChain `CallbackHandler`, привязанный к корневому трейсу. undefined при отсутствии пакета. */
async function makeLangchainHandler(
  trace: LangfuseTraceClientLike,
): Promise<LangchainCallbackLike | undefined> {
  try {
    const mod = (await import('langfuse-langchain')) as {
      CallbackHandler?: new (opts: Record<string, unknown>) => LangchainCallbackLike
      default?: new (opts: Record<string, unknown>) => LangchainCallbackLike
    }
    const CallbackHandler = mod.CallbackHandler ?? mod.default
    if (!CallbackHandler) return undefined
    // root → все LLM/tool-run'ы хода вложены в один трейс; updateRoot → io верхнего уровня на трейсе.
    return new CallbackHandler({ root: trace, updateRoot: true })
  } catch (e) {
    console.warn(
      `[ai37-agent-host] LangChain-трассировка отключена: 'langfuse-langchain' не загрузился (${String(e)})`,
    )
    return undefined
  }
}

export interface BeginTurnArgs {
  contextId: string
  taskId: string
  claims?: Claims
  metadata: Ai37Metadata
  /** Имя агента/трейса для UI Langfuse (по умолчанию 'agent-turn'). */
  agentName?: string
  /** Текст пользователя — кладётся во вход трейса. */
  text?: string
  billingOrgId?: string
}

/**
 * Открывает Langfuse-трейс хода и кладёт его + LangChain-хендлер в request-scope (ALS).
 * Возвращает срез (или null, если трассировка выключена). Никогда не бросает.
 */
export async function beginTurnObservability(
  args: BeginTurnArgs,
): Promise<TurnObservability | null> {
  const client = await getClient()
  if (!client) return null
  try {
    const traceId =
      (typeof args.metadata.trace_id === 'string' && args.metadata.trace_id) || randomUUID()
    const tags = [args.metadata.channel, args.metadata.app_id].filter(
      (t): t is string => typeof t === 'string' && t.length > 0,
    )
    const trace = client.trace({
      id: traceId,
      name: args.agentName ?? 'agent-turn',
      sessionId: args.contextId,
      ...(args.claims?.sub ? { userId: args.claims.sub } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(args.text !== undefined ? { input: { text: args.text } } : {}),
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
    const handler = await makeLangchainHandler(trace)
    const obs: TurnObservability = { traceId, trace, handler }
    const scope = requestScope.getStore()
    if (scope) scope.langfuse = obs
    return obs
  } catch (e) {
    console.warn(`[ai37-agent-host] Langfuse: не удалось открыть трейс хода (${String(e)})`)
    return null
  }
}

/** Дописывает выход хода в корневой трейс (status/message). Безопасно при выключенной трассировке. */
export function finishTurnObservability(output: {
  status?: string
  message?: string
}): void {
  const obs = requestScope.getStore()?.langfuse as TurnObservability | undefined
  if (!obs) return
  try {
    obs.trace.update({ output })
  } catch {
    /* трассировка не должна влиять на ход */
  }
}

/** Досылает накопленные события Langfuse. Зовётся в finally хода. Никогда не бросает. */
export async function flushTurnObservability(): Promise<void> {
  if (!clientSingleton) return
  try {
    await clientSingleton.flushAsync()
  } catch {
    /* no-op */
  }
}
