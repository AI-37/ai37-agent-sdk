import { expect, it, vi } from 'vitest'
import { cancelHarnessSession, closeHarnessSession, resumeStoredSession } from '../src/dsh'

it('cold resumes the exact stored identity using current model options', async () => {
  const handle = { value: 'native' }
  const resume = vi.fn().mockResolvedValue(handle)
  const stat = vi.fn().mockResolvedValue({ stored: true })
  expect(
    await resumeStoredSession({
      sessionId: 'one',
      persistence: { stat },
      agents: { resume },
      agentOptions: { model: 'trusted' },
    }),
  ).toBe(handle)
  expect(stat).toHaveBeenCalledWith('one')
  expect(resume).toHaveBeenCalledWith({
    resumeSessionId: 'one',
    agentOptions: { model: 'trusted' },
  })
})

it('lets the native server create a missing session without synthesizing history', async () => {
  const resume = vi.fn()
  expect(
    await resumeStoredSession({
      sessionId: 'new',
      persistence: { stat: async () => null },
      agents: { resume },
      agentOptions: {},
    }),
  ).toBeNull()
  expect(resume).not.toHaveBeenCalled()
})

it('waits for creation and disposes only the requested session', async () => {
  const dispose = vi.fn(async () => undefined)
  const other = { handle: { dispose: vi.fn() } }
  const sessions = new Map([['two', other]])
  const creation = Promise.resolve().then(() => {
    sessions.set('one', { handle: { dispose } })
  })
  expect(
    await closeHarnessSession({
      sessionId: 'one',
      sessions,
      creations: new Map([['one', creation]]),
    }),
  ).toEqual({ closed: true })
  expect(dispose).toHaveBeenCalledOnce()
  expect(sessions.get('two')).toBe(other)
  expect(await closeHarnessSession({ sessionId: 'one', sessions, creations: new Map() })).toEqual({
    closed: false,
  })
})

it('handles failed creation but exposes native disposal failures', async () => {
  const creations = new Map([['one', Promise.reject(new Error('creation failed'))]])
  const sessions = new Map([
    [
      'one',
      {
        handle: {
          dispose: async () => {
            throw new Error('dispose failed')
          },
        },
      },
    ],
  ])
  await expect(closeHarnessSession({ sessionId: 'one', sessions, creations })).rejects.toThrow(
    'dispose failed',
  )
  expect(sessions.has('one')).toBe(false)
})

it('cancels only the requested session using the native user cancellation reason', () => {
  const cancel = vi.fn()
  const other = vi.fn()
  const sessions = new Map([
    ['one', { handle: { agent: { cancel } } }],
    ['two', { handle: { agent: { cancel: other } } }],
  ])
  expect(cancelHarnessSession({ sessionId: 'one', sessions })).toEqual({ cancelled: true })
  expect(cancel).toHaveBeenCalledWith({ kind: 'user' })
  expect(other).not.toHaveBeenCalled()
  expect(cancelHarnessSession({ sessionId: 'missing', sessions })).toEqual({ cancelled: false })
})

it('rejects invalid lifecycle identifiers', async () => {
  await expect(
    resumeStoredSession({
      sessionId: '',
      persistence: { stat: vi.fn() },
      agents: { resume: vi.fn() },
      agentOptions: {},
    }),
  ).rejects.toThrow('sessionId')
  await expect(
    closeHarnessSession({ sessionId: ' ', sessions: new Map(), creations: new Map() }),
  ).rejects.toThrow('sessionId')
  expect(() => cancelHarnessSession({ sessionId: '', sessions: new Map() })).toThrow('sessionId')
})
