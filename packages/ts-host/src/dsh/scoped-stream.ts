import type { AsyncLocalStorage } from 'node:async_hooks'

/** Generator creation alone does not scope later/interleaved iterator advances. */
export function scopedAsyncIterable<S, T>(
  storage: AsyncLocalStorage<S>,
  scope: S,
  factory: () => AsyncIterable<T>,
): AsyncIterableIterator<T> {
  const iterator = storage.run(scope, () => factory()[Symbol.asyncIterator]())
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next: (value?: unknown) => storage.run(scope, () => iterator.next(value)),
    return: (value?: unknown) =>
      storage.run(scope, () => iterator.return?.(value) ?? Promise.resolve({ done: true, value })),
    throw: (error?: unknown) =>
      storage.run(scope, () => (iterator.throw ? iterator.throw(error) : Promise.reject(error))),
  }
}
