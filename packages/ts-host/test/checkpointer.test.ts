import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { AgentCard } from '@a2a-js/sdk'
import { OUTPUT_MODE_TEXT, OUTPUT_MODE_MARKDOWN } from '@ai37/agent-sdk'
import {
  createAgentHost,
  createCheckpointer,
  currentCheckpointer,
  type AgentHandler,
} from '../src/index'

// Мокаем ТОЛЬКО postgres-пакет: реальный `PostgresSaver.setup()` коннектится к БД (в юните
// недоступно). Фейковый saver со шпионом `setup` — чтобы детерминированно проверить, что
// databaseUrl уводит фабрику в PG-ветку и вызывает setup() (durable-схема).
const setupSpy = vi.fn(async () => {})
const fakePgSaver = { setup: setupSpy } as unknown as BaseCheckpointSaver
const fromConnString = vi.fn(() => fakePgSaver)
vi.mock('@langchain/langgraph-checkpoint-postgres', () => ({
  PostgresSaver: { fromConnString },
}))

const card: AgentCard = {
  name: 'CP Test Agent',
  description: 'test',
  version: '0.0.0',
  url: 'http://localhost/a2a/v1',
  protocolVersion: '0.3',
  preferredTransport: 'JSONRPC',
  capabilities: { streaming: true, pushNotifications: false },
  defaultInputModes: ['application/json'],
  defaultOutputModes: [OUTPUT_MODE_MARKDOWN, OUTPUT_MODE_TEXT],
  skills: [{ id: 's', name: 's', description: 'd', tags: [] }],
}

describe('createCheckpointer (фабрика durable-saver)', () => {
  it('без databaseUrl → MemorySaver (dev, не durable)', async () => {
    const cp = await createCheckpointer()
    expect(cp).toBeInstanceOf(MemorySaver)
  })

  it('пустой/пробельный databaseUrl → MemorySaver (trim)', async () => {
    const cp = await createCheckpointer({ databaseUrl: '   ' })
    expect(cp).toBeInstanceOf(MemorySaver)
  })

  it('databaseUrl задан → PostgresSaver.fromConnString + setup() (durable-ветка)', async () => {
    const cp = await createCheckpointer({
      databaseUrl: 'postgresql://u:p@db.internal:5432/agent',
    })
    expect(cp).toBe(fakePgSaver)
    expect(fromConnString).toHaveBeenCalledWith('postgresql://u:p@db.internal:5432/agent')
    expect(setupSpy).toHaveBeenCalledOnce()
  })
})

describe('currentCheckpointer — host прокидывает saver в turn-scope', () => {
  // handler читает currentCheckpointer() из ALS и кладёт в замыкание для проверки из теста.
  let seen: BaseCheckpointSaver | undefined | 'unset' = 'unset'
  const probeHandler: AgentHandler = {
    async run() {
      seen = currentCheckpointer()
      return { status: 'completed', message: 'ok' }
    },
  }

  function send(app: ReturnType<typeof createAgentHost>) {
    return request(app)
      .post('/a2a/v1')
      .send({
        jsonrpc: '2.0',
        id: '1',
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            messageId: 'm1',
            role: 'user',
            parts: [{ kind: 'text', text: 'hi' }],
          },
        },
      })
  }

  it('host с checkpointer → handler видит ТОТ ЖЕ инстанс через currentCheckpointer()', async () => {
    const sentinel = new MemorySaver()
    const app = createAgentHost({
      card,
      handler: probeHandler,
      checkpointer: sentinel,
      agentContext: {
        auth: { issuer: 'i', audience: 'a', required: false },
        billing: { baseUrl: 'http://localhost:9999' },
      },
    })
    const r = await send(app)
    expect(r.status).toBe(200)
    expect(seen).toBe(sentinel)
  })

  it('host без checkpointer → currentCheckpointer() === undefined (агент строит граф без durable)', async () => {
    const app = createAgentHost({
      card,
      handler: probeHandler,
      agentContext: {
        auth: { issuer: 'i', audience: 'a', required: false },
        billing: { baseUrl: 'http://localhost:9999' },
      },
    })
    const r = await send(app)
    expect(r.status).toBe(200)
    expect(seen).toBeUndefined()
  })
})
