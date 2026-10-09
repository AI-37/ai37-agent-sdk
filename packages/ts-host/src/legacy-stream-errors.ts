import type { NextFunction, Request, Response } from 'express'

const LEGACY_STREAM_METHODS = new Set(['message/stream', 'tasks/resubscribe'])

/**
 * Ошибку до первого события стрима клиенту A2A 0.3 отдаём событием SSE, как это делал сервер 0.3.
 *
 * `jsonRpcHandler` 1.x на `message/stream` сначала берёт первое событие и, если исполнение упало
 * сразу (задача не найдена, задача завершена), отвечает обычным JSON. Клиент `@a2a-js/sdk` 0.3
 * (0.3.13 и 0.3.14) такой ответ не разбирает: ждёт `text/event-stream` и бросает «Invalid response
 * Content-Type», без кода и текста ошибки. Relay 0.3 тогда не узнаёт устаревшую задачу и роняет
 * ход, а должен повторить его новым диалогом (план docs#465, §3.2: паузы, потерянные при переезде
 * агента на Postgres, восстанавливаются именно этим повтором).
 *
 * Только для запросов 0.3 (без `A2A-Version` или с `0.3`). Клиент 1.x JSON-ошибку понимает.
 */
export function legacyStreamErrorsAsSse(req: Request, res: Response, next: NextFunction): void {
  const version = req.header('A2A-Version') ?? '0.3'
  const method = (req.body as { method?: unknown } | undefined)?.method
  if (version !== '0.3' || typeof method !== 'string' || !LEGACY_STREAM_METHODS.has(method)) {
    next()
    return
  }
  const json = res.json.bind(res)
  res.json = (body: unknown) => {
    // Только ошибки протокола (SDK отдаёт их со статусом 200). Сбой сервера (500) остаётся JSON с
    // 500: в SSE 200 он пропал бы из мониторинга, а клиент 0.3 и так получит «HTTP 500».
    if (res.headersSent || res.statusCode !== 200 || !isJsonRpcError(body)) return json(body)
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.end(`event: error\ndata: ${JSON.stringify(body)}\n\n`)
    return res
  }
  next()
}

function isJsonRpcError(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'error' in body && 'jsonrpc' in body
}

/**
 * `message/send` клиента 0.3 без `configuration.blocking` — блокирующий, как у сервера 0.3
 * (`blocking !== false`).
 *
 * Compat-слой `@a2a-js/sdk` 1.3 переводит отсутствующий `blocking` в `returnImmediately: true`
 * (`toCoreSendMessageConfiguration`): обработчик отвечает на первом событии задачи, а у агента с
 * прогрессом это `working` из `A2aProgress`. Клиент 0.3, который прислал `configuration` (например,
 * только `acceptedOutputModes`) без `blocking`, получил бы незавершённую задачу без текста. Клиент
 * `@a2a-js/sdk` 0.3 сам ставит `blocking: true`, поэтому наш relay не затронут; это защита для
 * самописных клиентов 0.3. После перевода в 1.x «не задан» и `false` уже не различить, поэтому
 * правим сырое тело до compat. Без `configuration` compat и так даёт блокирующий вызов.
 */
export function legacyBlockingDefault(req: Request, _res: Response, next: NextFunction): void {
  const version = req.header('A2A-Version') ?? '0.3'
  const body = req.body as
    | { method?: unknown; params?: { configuration?: Record<string, unknown> | null } }
    | undefined
  const configuration = body?.params?.configuration
  if (
    version === '0.3' &&
    body?.method === 'message/send' &&
    configuration !== null &&
    typeof configuration === 'object' &&
    configuration.blocking === undefined
  ) {
    configuration.blocking = true
  }
  next()
}
