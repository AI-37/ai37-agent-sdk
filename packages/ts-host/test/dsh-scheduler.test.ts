import { describe, expect, it } from 'vitest'
import { BoundedConcurrencyLimiter, PerSessionScheduler } from '../src/dsh'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('PerSessionScheduler', () => {
  it('runs independent sessions concurrently', async () => {
    const scheduler = new PerSessionScheduler()
    const entered = [deferred(), deferred()]
    const release = deferred()
    const work = entered.map((ready, index) =>
      scheduler.run(String(index), async () => {
        ready.resolve()
        await release.promise
      }),
    )
    await Promise.all(entered.map((ready) => ready.promise))
    release.resolve()
    await Promise.all(work)
  })

  it('preserves session FIFO order across a failure and later bursts', async () => {
    const scheduler = new PerSessionScheduler()
    const release = deferred()
    const order: string[] = []
    const first = scheduler.run('same', async () => {
      order.push('first')
      await release.promise
      throw new Error('first failed')
    })
    const failed = expect(first).rejects.toThrow('first failed')
    const second = scheduler.run('same', async () => {
      order.push('second')
    })
    const third = scheduler.run('same', async () => {
      order.push('third')
    })
    await Promise.resolve()
    expect(order).toEqual(['first'])
    release.resolve()
    await Promise.all([failed, second, third])
    await scheduler.run('same', async () => {
      order.push('fourth')
    })
    expect(order).toEqual(['first', 'second', 'third', 'fourth'])
  })
})

describe('BoundedConcurrencyLimiter', () => {
  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid concurrency %s', (limit) => {
    expect(() => new BoundedConcurrencyLimiter(limit)).toThrow('positive integer')
  })

  it.each([1, 4])(
    'preserves FIFO admission and capacity over bursts at limit %i',
    async (limit) => {
      const limiter = new BoundedConcurrencyLimiter(limit)
      for (let burst = 0; burst < 3; burst += 1) {
        let active = 0
        let peak = 0
        const order: number[] = []
        const expected = Array.from({ length: 10 }, (_, index) => index)
        const values = await Promise.all(
          expected.map((index) =>
            limiter.run(async () => {
              order.push(index)
              peak = Math.max(peak, ++active)
              await Promise.resolve()
              active -= 1
              return index
            }),
          ),
        )
        expect(values).toEqual(expected)
        expect(order).toEqual(expected)
        expect(peak).toBe(limit)
        expect(active).toBe(0)
      }
    },
  )

  it('recovers all slots after both running and queued operations fail', async () => {
    const limiter = new BoundedConcurrencyLimiter(4)
    const failures = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        limiter.run(async () => {
          throw new Error('operation failed')
        }),
      ),
    )
    expect(failures.every((result) => result.status === 'rejected')).toBe(true)
    const ready = Array.from({ length: 4 }, () => deferred())
    const release = deferred()
    const work = ready.map((entered) =>
      limiter.run(async () => {
        entered.resolve()
        await release.promise
      }),
    )
    await Promise.all(ready.map((entered) => entered.promise))
    release.resolve()
    await Promise.all(work)
  })
})
