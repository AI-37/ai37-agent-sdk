/** Stable metadata envelope shared by every AI37 host trace. */
export const TRACE_SCHEMA_VERSION = 'trace.v1' as const

export type TraceKind = 'turn' | 'planner' | 'agent' | 'generation' | 'tool'

export type TraceStatus =
  'working' | 'input-required' | 'completed' | 'failed' | 'cancelled'

export interface TraceMetadataV1 {
  schemaVersion: typeof TRACE_SCHEMA_VERSION
  traceKind: TraceKind
  service: string
  environment: string
  turnId: string
  sessionId: string
  taskId?: string
  runId?: string
  agentId?: string
  status?: TraceStatus
  intent?: string
  route?: string
  reasonCode?: string
  confidence?: number
  payloadMode?: 'inline' | 'inline-truncated' | 'external'
  [key: string]: unknown
}

export function traceMetadata(
  traceKind: TraceKind,
  fields: Omit<Partial<TraceMetadataV1>, 'schemaVersion' | 'traceKind'> &
    Pick<TraceMetadataV1, 'turnId' | 'sessionId'>,
): TraceMetadataV1 {
  return {
    ...fields,
    schemaVersion: TRACE_SCHEMA_VERSION,
    traceKind,
    service:
      typeof fields.service === 'string' && fields.service.length > 0
        ? fields.service
        : 'ai37-agent-host',
    environment:
      typeof fields.environment === 'string' && fields.environment.length > 0
        ? fields.environment
        : process.env.LANGFUSE_TRACING_ENVIRONMENT ||
          process.env.NODE_ENV ||
          'development',
  }
}
