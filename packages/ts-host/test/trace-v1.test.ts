import { describe, expect, it } from 'vitest'
import {
  TRACE_SCHEMA_VERSION,
  traceMetadata,
} from '../src/observability/trace-v1'

describe('trace.v1 metadata', () => {
  it('adds stable correlation and environment fields', () => {
    expect(
      traceMetadata('turn', {
        turnId: 'turn-1',
        sessionId: 'chat-1',
        service: 'test-agent',
        environment: 'test',
        status: 'working',
      }),
    ).toMatchObject({
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceKind: 'turn',
      service: 'test-agent',
      environment: 'test',
      turnId: 'turn-1',
      sessionId: 'chat-1',
      status: 'working',
    })
  })

  it('keeps sessionId/turnId distinct from optional OTel traceId', () => {
    // Контракт одного дерева: session = диалог (contextId), turn = ход (taskId),
    // traceId = OTel id цепочки. Нельзя подставлять traceId в sessionId/turnId.
    const meta = traceMetadata('agent', {
      turnId: 'task-1',
      sessionId: 'context-1',
      service: 'ai37-agent-host',
      environment: 'dev',
      agentId: 'lift-calc',
      kind: 'remote-a2a',
      traceId: 'abcdef0123456789abcdef0123456789',
    })
    expect(meta.sessionId).toBe('context-1')
    expect(meta.turnId).toBe('task-1')
    expect(meta.traceId).toBe('abcdef0123456789abcdef0123456789')
    expect(meta.sessionId).not.toBe(meta.traceId)
    expect(meta.turnId).not.toBe(meta.traceId)
  })
})
