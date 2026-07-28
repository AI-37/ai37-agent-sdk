import { Registry, Counter, Histogram } from 'prom-client'
import type { AgentStatus } from './types'

/**
 * Prometheus-метрики хоста. Единый Registry, ТОЛЬКО низкокардинальные `ai37_*`-серии
 * (лейблы ограничены service/transport/status/final_state/reason — никаких per-user /
 * per-context / per-request значений). Скрейпится внутрикластерным Alloy'ем по `GET /metrics`
 * (k8s-monitoring annotationAutodiscovery, includeMetrics=`ai37_.*`).
 *
 * `collectDefaultMetrics()` НЕ вызываем: process_/nodejs_ не проходят allowlist и лишь раздули
 * бы бюджет активных серий. Все инкременты обёрнуты в `safe()` и НИКОГДА не бросают — сбой
 * метрик не должен ломать ход агента.
 */
export const registry = new Registry()

const requestsTotal = new Counter({
  name: 'ai37_agent_requests_total',
  help: 'Total agent turns handled by the host, by transport and outcome (ok|error).',
  labelNames: ['service', 'transport', 'status'] as const,
  registers: [registry],
})

const requestDuration = new Histogram({
  name: 'ai37_agent_request_duration_seconds',
  help: 'Agent turn duration in seconds, by transport.',
  labelNames: ['service', 'transport'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [registry],
})

const tasksTotal = new Counter({
  name: 'ai37_agent_tasks_total',
  help: 'Terminal task states produced by the host (completed|failed|input_required).',
  labelNames: ['service', 'final_state'] as const,
  registers: [registry],
})

const billingDeniedTotal = new Counter({
  name: 'ai37_billing_denied_total',
  help: 'Billing preflight denials surfaced by the host, by reason.',
  labelNames: ['service', 'reason'] as const,
  registers: [registry],
})

const authFailuresTotal = new Counter({
  name: 'ai37_agent_auth_failures_total',
  help: '401 responses from the host JWT guard.',
  labelNames: ['service'] as const,
  registers: [registry],
})

/** Нормализует AgentStatus в label-safe значение (`input-required` → `input_required`). */
export function normFinalState(status: AgentStatus): string {
  return status === 'input-required' ? 'input_required' : status
}

/**
 * `service`-лейбл из имени агент-карты: строчный slug из `[a-z0-9_-]`, обрезанный до 63 симв.
 * Значение ФИКСИРОВАНО на процесс (одно на деплой) → кардинальность лейбла = 1.
 */
export function serviceLabel(name: string | undefined): string {
  const s = (name ?? 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
  return s || 'unknown'
}

function safe(fn: () => void): void {
  try {
    fn()
  } catch {
    /* метрики не должны ломать ход агента */
  }
}

/** Один ход (turn) на транспорте `a2a`/`agui`/`mcp`: rate + errors + duration + terminal-state. */
export function observeTurn(
  service: string,
  transport: 'a2a' | 'agui' | 'mcp',
  finalState: string,
  seconds: number,
): void {
  safe(() => {
    requestsTotal.inc({ service, transport, status: finalState === 'failed' ? 'error' : 'ok' })
    requestDuration.observe({ service, transport }, seconds)
    tasksTotal.inc({ service, final_state: finalState })
  })
}

/** Отказ биллинг-preflight (BillingExecutionDeniedError.reason). */
export function recordBillingDenied(service: string, reason: string): void {
  safe(() => billingDeniedTotal.inc({ service, reason }))
}

/** 401 из jwtGuard (сбой Authentik/JWKS/верификатора). */
export function recordAuthFailure(service: string): void {
  safe(() => authFailuresTotal.inc({ service }))
}

/** Content-Type для ответа `GET /metrics` (Prometheus text exposition). */
export const metricsContentType = registry.contentType

/** Рендер экспозиции метрик для `GET /metrics`. */
export async function renderMetrics(): Promise<string> {
  return registry.metrics()
}
