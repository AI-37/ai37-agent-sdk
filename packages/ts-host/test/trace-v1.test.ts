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
})
