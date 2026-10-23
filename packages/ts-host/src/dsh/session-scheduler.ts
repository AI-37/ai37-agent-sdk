/** FIFO serialization within a session; independent sessions remain concurrent. */
export class PerSessionScheduler {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tails.set(sessionId, current)
    return previous.then(operation).finally(() => {
      release()
      if (this.tails.get(sessionId) === current) this.tails.delete(sessionId)
    })
  }
}

/** Fair FIFO admission for a shared runtime, including failed operations. */
export class BoundedConcurrencyLimiter {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('DSH concurrency limit must be a positive integer')
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await operation()
    } finally {
      const next = this.waiters.shift()
      if (next) next()
      else this.active -= 1
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }
}
