import { expect, it, vi } from 'vitest'
import { SingleHarnessRuntime } from '../src/dsh'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function harness() {
  return { close: vi.fn(async (): Promise<void> => undefined), run: vi.fn(async () => 'answer') }
}

it('is lazy, shares startup and preserves the concrete harness type', async () => {
  const instance = harness()
  const startup = deferred<typeof instance>()
  const entered = deferred()
  const factory = vi.fn(() => {
    entered.resolve()
    return startup.promise
  })
  const runtime = new SingleHarnessRuntime(factory)
  expect(factory).not.toHaveBeenCalled()
  const first = runtime.use((child) => child.run())
  const second = runtime.use((child) => child.run())
  await entered.promise
  expect(factory).toHaveBeenCalledOnce()
  startup.resolve(instance)
  await expect(Promise.all([first, second])).resolves.toEqual(['answer', 'answer'])
  await runtime.close()
  expect(instance.close).toHaveBeenCalledOnce()
})

it('allows a later operation to retry a failed startup', async () => {
  const instance = harness()
  const factory = vi.fn().mockRejectedValueOnce(new Error('startup')).mockResolvedValue(instance)
  const runtime = new SingleHarnessRuntime<typeof instance>(factory)
  await expect(runtime.use((child) => child.run())).rejects.toThrow('startup')
  await expect(runtime.use((child) => child.run())).resolves.toBe('answer')
  expect(factory).toHaveBeenCalledTimes(2)
  await runtime.close()
})

it('handles a synchronously throwing factory without poisoning the next startup', async () => {
  const instance = harness()
  let attempt = 0
  const runtime = new SingleHarnessRuntime(() => {
    if (attempt++ === 0) throw new Error('sync startup')
    return Promise.resolve(instance)
  })
  await expect(runtime.use((child) => child.run())).rejects.toThrow('sync startup')
  await expect(runtime.use((child) => child.run())).resolves.toBe('answer')
  await runtime.close()
})

it('does not invalidate a child while a different session is running', async () => {
  const instance = harness()
  const runtime = new SingleHarnessRuntime(async () => instance)
  const entered = deferred()
  const release = deferred()
  const other = runtime.use(async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  await expect(
    runtime.use(async () => {
      throw new Error('transport')
    }),
  ).rejects.toThrow('transport')
  expect(await runtime.invalidateIfIdle(instance)).toBe(false)
  expect(instance.close).not.toHaveBeenCalled()
  release.resolve()
  await other
  expect(await runtime.invalidateIfIdle(instance)).toBe(true)
  expect(instance.close).toHaveBeenCalledOnce()
  await runtime.close()
})

it('ignores a stale expected child after a replacement starts', async () => {
  const first = harness()
  const second = harness()
  const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second)
  const runtime = new SingleHarnessRuntime<typeof first>(factory)
  expect(await runtime.invalidateIfIdle()).toBe(false)
  await runtime.use((child) => child.run())
  expect(await runtime.invalidateIfIdle(first)).toBe(true)
  await runtime.use((child) => child.run())
  expect(await runtime.invalidateIfIdle(first)).toBe(false)
  expect(second.close).not.toHaveBeenCalled()
  await runtime.close()
})

it('waits for invalidation to close the old child before starting another', async () => {
  const first = harness()
  const release = deferred()
  first.close.mockImplementationOnce(() => release.promise)
  const second = harness()
  const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(second)
  const runtime = new SingleHarnessRuntime<typeof first>(factory)
  await runtime.use((child) => child.run())
  const invalidating = runtime.invalidateIfIdle(first)
  const next = runtime.use((child) => child.run())
  expect(await runtime.invalidateIfIdle()).toBe(false)
  await Promise.resolve()
  expect(factory).toHaveBeenCalledOnce()
  release.resolve()
  await expect(invalidating).resolves.toBe(true)
  await expect(next).resolves.toBe('answer')
  expect(factory).toHaveBeenCalledTimes(2)
  await runtime.close()
})

it('stops admission after a failed invalidation and retries cleanup during shutdown', async () => {
  const instance = harness()
  instance.close.mockRejectedValueOnce(new Error('close failed'))
  const factory = vi.fn(async () => instance)
  const runtime = new SingleHarnessRuntime(factory)
  await runtime.use((child) => child.run())
  await expect(runtime.invalidateIfIdle()).rejects.toThrow('close failed')
  await expect(runtime.use((child) => child.run())).rejects.toThrow('closed')
  expect(factory).toHaveBeenCalledOnce()
  await runtime.close()
  expect(instance.close).toHaveBeenCalledTimes(2)
})

it('drains startup and accepted operations when closing, and rejects new work', async () => {
  const instance = harness()
  const startup = deferred<typeof instance>()
  const release = deferred()
  const runtime = new SingleHarnessRuntime(() => startup.promise)
  const running = runtime.use(async () => release.promise)
  const closing = runtime.close()
  expect(runtime.close()).toBe(closing)
  await expect(runtime.use((child) => child.run())).rejects.toThrow('closed')
  startup.resolve(instance)
  await Promise.resolve()
  expect(instance.close).not.toHaveBeenCalled()
  release.resolve()
  await running
  await closing
  expect(instance.close).toHaveBeenCalledOnce()
  expect(await runtime.invalidateIfIdle()).toBe(false)
})

it('drains a failed operation before closing the shared child', async () => {
  const instance = harness()
  const entered = deferred()
  const release = deferred()
  const runtime = new SingleHarnessRuntime(async () => instance)
  const running = runtime.use(async () => {
    entered.resolve()
    await release.promise
    throw new Error('operation')
  })
  const failure = expect(running).rejects.toThrow('operation')
  await entered.promise
  const closing = runtime.close()
  expect(instance.close).not.toHaveBeenCalled()
  release.resolve()
  await failure
  await closing
  expect(instance.close).toHaveBeenCalledOnce()
})

it('waits for an idle invalidation already in progress during shutdown', async () => {
  const instance = harness()
  const release = deferred()
  instance.close.mockImplementationOnce(() => release.promise)
  const runtime = new SingleHarnessRuntime(async () => instance)
  await runtime.use((child) => child.run())
  const invalidating = runtime.invalidateIfIdle()
  const closing = runtime.close()
  release.resolve()
  await invalidating
  await closing
  expect(instance.close).toHaveBeenCalledOnce()
})

it('does not start an unused child on close and reports a child shutdown failure', async () => {
  const factory = vi.fn(async () => harness())
  const unused = new SingleHarnessRuntime(factory)
  await unused.close()
  expect(factory).not.toHaveBeenCalled()
  const instance = harness()
  instance.close.mockRejectedValue(new Error('shutdown'))
  const runtime = new SingleHarnessRuntime(async () => instance)
  await runtime.use((child) => child.run())
  const closing = runtime.close()
  await expect(closing).rejects.toThrow('shutdown')
  expect(runtime.close()).toBe(closing)
  expect(instance.close).toHaveBeenCalledOnce()
})

it('cleans up an invalidation that fails while shutdown is already waiting', async () => {
  const instance = harness()
  const release = deferred()
  instance.close.mockImplementationOnce(() => release.promise)
  const factory = vi.fn(async () => instance)
  const runtime = new SingleHarnessRuntime(factory)
  await runtime.use((child) => child.run())
  const invalidating = runtime.invalidateIfIdle()
  const failure = expect(invalidating).rejects.toThrow('closing failed')
  const closing = runtime.close()
  release.reject(new Error('closing failed'))
  await failure
  await closing
  expect(factory).toHaveBeenCalledOnce()
  expect(instance.close).toHaveBeenCalledTimes(2)
})

it('finishes shutdown after an accepted startup rejects', async () => {
  const startup = deferred<ReturnType<typeof harness>>()
  const runtime = new SingleHarnessRuntime(() => startup.promise)
  const running = runtime.use((child) => child.run())
  const failure = expect(running).rejects.toThrow('unavailable')
  const closing = runtime.close()
  startup.reject(new Error('unavailable'))
  await failure
  await closing
  await expect(runtime.use((child) => child.run())).rejects.toThrow('closed')
})
