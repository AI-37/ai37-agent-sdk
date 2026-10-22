import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

/** Verified, caller-owned credentials. Never put this object in a prompt or journal. */
export interface HarnessRequestContext {
  readonly sessionId: string
  readonly llmKey: string
  readonly expiresAt: number
  readonly tools: readonly string[]
}

export interface HarnessToolCall {
  readonly name: string
  readonly arguments: Record<string, unknown>
  readonly signal: AbortSignal
}

export interface HarnessRequestBinding {
  readonly bindingId: string
  release(): Promise<void>
}

export interface RequestBridgeOptions<T extends HarnessRequestContext> {
  timeoutMs: number
  maxBodyBytes?: number
  dispatch: (context: T, call: HarnessToolCall) => Promise<unknown>
}

interface Binding<T> {
  bindingId: string
  context: T
  tools: ReadonlySet<string>
  abort: AbortController
  signal: AbortSignal
  timer: NodeJS.Timeout
}

/** Private parent/child credential and tool dispatch, extracted from the search host. */
export class ScopedRequestBridge<T extends HarnessRequestContext> {
  private readonly secret = randomBytes(32).toString('hex')
  private readonly bindings = new Map<string, Binding<T>>()
  private readonly server = createServer((req, res) => {
    void this.handle(req, res).catch(() => reply(res, 502, { error: 'Bridge request failed' }))
  })
  private starting?: Promise<string>
  private closing?: Promise<void>
  private closed = false

  constructor(private readonly options: RequestBridgeOptions<T>) {
    positiveLimit(options.timeoutMs, 2_147_483_647)
    positiveLimit(options.maxBodyBytes ?? 1_048_576, 16_777_216)
  }

  async start(): Promise<{ url: string; secret: string }> {
    if (this.closed) throw new Error('Request bridge is closed')
    this.starting ??= this.listen()
    return { url: await this.starting, secret: this.secret }
  }

  /** Duplicate sessions fail closed; an old release cannot revoke a later binding. */
  async bind(context: T, stopSignal?: AbortSignal): Promise<HarnessRequestBinding> {
    if (this.closed) throw new Error('Request bridge is closed')
    stopSignal?.throwIfAborted()
    validateContext(context)
    if (this.bindings.has(context.sessionId)) throw new Error('Session already active')
    const abort = new AbortController()
    const signal = stopSignal ? AbortSignal.any([abort.signal, stopSignal]) : abort.signal
    const release = async () => {
      clearTimeout(binding.timer)
      abort.abort()
      if (this.bindings.get(context.sessionId) === binding) this.bindings.delete(context.sessionId)
    }
    const timer = setTimeout(
      release,
      Math.min(this.options.timeoutMs, context.expiresAt - Date.now()),
    )
    timer.unref()
    const binding: Binding<T> = {
      bindingId: randomBytes(32).toString('hex'),
      context: Object.freeze({ ...context }),
      tools: new Set(context.tools),
      abort,
      signal,
      timer,
    }
    this.bindings.set(context.sessionId, binding)
    return { bindingId: binding.bindingId, release }
  }

  /** Terminal and idempotent. All pending tool calls receive cancellation. */
  close(): Promise<void> {
    this.closed = true
    this.closing ??= this.finishClose()
    return this.closing
  }

  private listen(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject)
        this.server.unref()
        const address = this.server.address()
        if (!address || typeof address === 'string') return reject(new Error('No bridge address'))
        resolve(`http://127.0.0.1:${address.port}`)
      })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorized(req, this.secret)) return reply(res, 401, { error: 'Unauthorized' })
    if (!knownRoute(req)) {
      return reply(res, 404, { error: 'Not found' })
    }
    const body = await readBody(req, this.options.maxBodyBytes ?? 1_048_576)
    if (!body) return reply(res, 400, { error: 'Invalid request body' })
    const binding =
      typeof body.sessionId === 'string' ? this.bindings.get(body.sessionId) : undefined
    if (!binding || body.bindingId !== binding.bindingId || !active(binding)) {
      return reply(res, 403, { error: 'No active request context' })
    }
    if (req.url === '/credential') return reply(res, 200, { key: binding.context.llmKey })
    await this.dispatch(binding, body, res)
  }

  private async dispatch(binding: Binding<T>, body: Record<string, unknown>, res: ServerResponse) {
    if (typeof body.name !== 'string' || !binding.tools.has(body.name)) {
      return reply(res, 403, { error: 'Tool unavailable' })
    }
    if (body.arguments !== undefined && !isRecord(body.arguments)) {
      return reply(res, 400, { error: 'Invalid tool arguments' })
    }
    const result = await this.options.dispatch(binding.context, {
      name: body.name,
      arguments: isRecord(body.arguments) ? body.arguments : {},
      signal: binding.signal,
    })
    if (!active(binding) || this.bindings.get(binding.context.sessionId) !== binding) {
      return reply(res, 403, { error: 'Request context closed' })
    }
    return reply(res, 200, result)
  }

  private async finishClose(): Promise<void> {
    for (const binding of this.bindings.values()) {
      clearTimeout(binding.timer)
      binding.abort.abort()
    }
    this.bindings.clear()
    if (!this.starting) return
    await this.starting
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

function positiveLimit(value: number, max: number) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error('Invalid bridge limit')
}

function validateContext(context: HarnessRequestContext) {
  if (!context.sessionId.trim() || context.sessionId.length > 256 || !context.llmKey.trim()) {
    throw new Error('Invalid request context')
  }
  if (typeof context.expiresAt !== 'number' || !(context.expiresAt > Date.now())) {
    throw new Error('Request context expired')
  }
  if (
    context.tools.some((name) => !name.trim()) ||
    new Set(context.tools).size !== context.tools.length
  ) {
    throw new Error('Invalid request tools')
  }
}

function active(binding: Binding<HarnessRequestContext>): boolean {
  return !binding.signal.aborted && binding.context.expiresAt > Date.now()
}

function authorized(req: IncomingMessage, secret: string): boolean {
  const actual = Buffer.from(req.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${secret}`)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function knownRoute(req: IncomingMessage): boolean {
  return req.method === 'POST' && (req.url === '/credential' || req.url === '/tool')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readBody(
  req: IncomingMessage,
  max: number,
): Promise<Record<string, unknown> | null> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > max) {
      req.resume()
      return null
    }
    chunks.push(Buffer.from(chunk))
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return isRecord(body) ? body : null
  } catch {
    return null
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
