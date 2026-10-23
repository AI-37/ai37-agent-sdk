/** The lifecycle surface required from a caller-owned harness implementation. */
export interface ManagedHarness {
  close(): Promise<void>
}

/**
 * Lazily owns one shared child. Accepted operations finish before shutdown;
 * invalidation never interrupts a different session using the same child.
 * This module does not import or start a particular harness implementation.
 */
export class SingleHarnessRuntime<T extends ManagedHarness> {
  private harness?: T
  private starting?: Promise<T>
  private invalidating?: Promise<void>
  private shutdown?: Promise<void>
  private closed = false
  private active = 0
  private drained?: () => void

  /** The factory owns cleanup of a partially started child until it resolves. */
  constructor(private readonly factory: () => Promise<T>) {}

  async use<R>(operation: (harness: T) => Promise<R>): Promise<R> {
    if (this.closed) throw new Error('DSH runtime is closed')
    this.active += 1
    try {
      await this.invalidating
      return await operation(await this.get())
    } finally {
      this.active -= 1
      if (this.active === 0) this.drained?.()
    }
  }

  /** Returns false for an active, stale, closing, or not-yet-started child. */
  async invalidateIfIdle(expected?: T): Promise<boolean> {
    if (this.closed || this.active > 0 || this.invalidating || !this.harness) return false
    if (expected && this.harness !== expected) return false
    const instance = this.harness
    this.harness = undefined
    const invalidating = Promise.resolve()
      .then(() => instance.close())
      .catch((error: unknown) => {
        // A failed close may leave a child alive: never start a second one.
        this.harness = instance
        this.closed = true
        throw error
      })
      .finally(() => {
        this.invalidating = undefined
      })
    this.invalidating = invalidating
    await invalidating
    return true
  }

  /** Terminal and idempotent. The caller must cancel stuck operations separately. */
  close(): Promise<void> {
    this.closed = true
    this.shutdown ??= this.finishShutdown()
    return this.shutdown
  }

  private async get(): Promise<T> {
    if (this.harness) return this.harness
    if (this.starting) return this.starting
    const starting = Promise.resolve().then(this.factory)
    this.starting = starting
    try {
      const instance = await starting
      this.harness = instance
      return instance
    } finally {
      this.starting = undefined
    }
  }

  private async finishShutdown(): Promise<void> {
    if (this.active > 0) {
      await new Promise<void>((resolve) => {
        this.drained = resolve
      })
      this.drained = undefined
    }
    // Retry a failed invalidation's close once as part of terminal cleanup.
    await this.invalidating?.catch(() => undefined)
    const instance = this.harness
    this.harness = undefined
    await instance?.close()
  }
}
