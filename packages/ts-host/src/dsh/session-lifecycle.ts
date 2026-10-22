interface ResumeOptions<H> {
  sessionId: string
  persistence: { stat(sessionId: string): Promise<unknown> }
  agents: {
    resume(options: { resumeSessionId: string; agentOptions: Record<string, unknown> }): Promise<H>
  }
  agentOptions: Record<string, unknown>
}

/** Cold-process resume through the native harness API, with caller-owned model options. */
export async function resumeStoredSession<H>(options: ResumeOptions<H>): Promise<H | null> {
  assertSession(options.sessionId)
  if (!(await options.persistence.stat(options.sessionId))) return null
  return options.agents.resume({
    resumeSessionId: options.sessionId,
    agentOptions: options.agentOptions,
  })
}

interface CloseOptions<H> {
  sessionId: string
  sessions: Map<string, { handle: H }>
  creations: ReadonlyMap<string, Promise<unknown>>
}

/** Call only after the turn has stopped: disposal drains the native persistence lease. */
export async function closeHarnessSession<H extends { dispose(): Promise<void> }>(
  options: CloseOptions<H>,
): Promise<{ closed: boolean }> {
  assertSession(options.sessionId)
  await options.creations.get(options.sessionId)?.catch(() => undefined)
  const record = options.sessions.get(options.sessionId)
  if (!record) return { closed: false }
  options.sessions.delete(options.sessionId)
  await record.handle.dispose()
  return { closed: true }
}

interface CancelableHandle {
  agent: { cancel(reason: { kind: 'user' }): unknown }
}

/** Cancels only the selected live session; it never closes the shared harness process. */
export function cancelHarnessSession<H extends CancelableHandle>(options: {
  sessionId: string
  sessions: ReadonlyMap<string, { handle: H }>
}): { cancelled: boolean } {
  assertSession(options.sessionId)
  const record = options.sessions.get(options.sessionId)
  if (!record) return { cancelled: false }
  record.handle.agent.cancel({ kind: 'user' })
  return { cancelled: true }
}

function assertSession(sessionId: string) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('Missing sessionId')
}
