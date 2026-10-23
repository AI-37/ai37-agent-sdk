import { AsyncLocalStorage } from 'node:async_hooks'
import { expect, it } from 'vitest'
import { scopedAsyncIterable } from '../src/dsh'

it('restores the correct scope for interleaved creation, next, return and throw', async () => {
  const storage = new AsyncLocalStorage<string>()
  const scopes: string[] = []
  const make = (scope: string) =>
    scopedAsyncIterable(storage, scope, (): AsyncIterableIterator<string | undefined> => {
      scopes.push(`create:${storage.getStore()}`)
      return {
        [Symbol.asyncIterator]() {
          return this
        },
        async next() {
          return { done: false, value: storage.getStore() }
        },
        async return() {
          scopes.push(`return:${storage.getStore()}`)
          return { done: true, value: undefined }
        },
        async throw() {
          scopes.push(`throw:${storage.getStore()}`)
          throw new Error('stopped')
        },
      }
    })
  const one = make('one')
  const two = make('two')
  expect(one[Symbol.asyncIterator]()).toBe(one)
  expect((await one.next()).value).toBe('one')
  expect((await two.next()).value).toBe('two')
  expect((await one.next()).value).toBe('one')
  await one.return?.()
  await expect(two.throw?.(new Error('stop'))).rejects.toThrow('stopped')
  expect(scopes).toEqual(['create:one', 'create:two', 'return:one', 'throw:two'])
  expect(storage.getStore()).toBeUndefined()
})

it('supports iterators without optional return/throw and propagates rejection', async () => {
  const storage = new AsyncLocalStorage<string>()
  const stream = scopedAsyncIterable(storage, 'one', () => ({
    [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
  }))
  expect(await stream.return?.('done')).toEqual({ done: true, value: 'done' })
  await expect(stream.throw?.(new Error('fail'))).rejects.toThrow('fail')
})
