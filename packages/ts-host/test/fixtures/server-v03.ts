// A2A-сервер на @a2a-js/sdk 0.3 (npm-алиас a2a-sdk-v03) в той форме, в какой отвечают агенты на
// @ai37/agent-host 0.1.x: прогресс status-update с metadata `ai37/node`, финал — один `task`, форма
// input-required в `task.metadata.a2ui`, состояние мастера в `task.metadata.state`. Нужен тестам
// смешанного парка: relay 1.x против агента, который ещё не переехал.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { v4 as uuidv4 } from 'uuid'
import type { AgentCard, Message, Task } from 'a2a-sdk-v03'
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from 'a2a-sdk-v03/server'
import { jsonRpcHandler, UserBuilder } from 'a2a-sdk-v03/server/express'

export interface V03Server {
  url: string
  /** Заголовки каждого A2A-запроса (проверка A2A-Version и форварда авторизации). */
  seen: IncomingHttpHeaders[]
  close(): Promise<void>
}

const now = (): string => new Date().toISOString()

function agentText(taskId: string, contextId: string, text: string): Message {
  return { kind: 'message', messageId: uuidv4(), role: 'agent', parts: [{ kind: 'text', text }], taskId, contextId }
}

/**
 * Мастер из двух шагов: первый ход — `input-required` с формой и `state.step = 1`, продолжение
 * тем же taskId — `completed`. Текст `progress` в сообщении включает события прогресса.
 */
class WizardV03 implements AgentExecutor {
  async execute(rc: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = rc
    const textPart = rc.userMessage.parts.find((p) => p.kind === 'text')
    const text = textPart?.kind === 'text' ? textPart.text : ''
    if (text.includes('progress')) {
      bus.publish({ kind: 'task', id: taskId, contextId, status: { state: 'working', timestamp: now() }, history: [] })
      bus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: { state: 'working', timestamp: now() },
        final: false,
        metadata: { 'ai37/node': 'work' },
      })
    }
    const step = (rc.task?.metadata?.state as { step?: number } | undefined)?.step ?? 0
    if (step === 0) {
      bus.publish({
        kind: 'task',
        id: taskId,
        contextId,
        status: { state: 'input-required', message: agentText(taskId, contextId, 'уточните'), timestamp: now() },
        metadata: {
          a2ui: [{ component: { component: 'FormCard', props: { step: 1 } }, surfaceId: `surf-${taskId}` }],
          state: { step: 1 },
        },
      })
    } else {
      bus.publish({
        kind: 'task',
        id: taskId,
        contextId,
        status: { state: 'completed', message: agentText(taskId, contextId, 'готово'), timestamp: now() },
        metadata: { state: { step: step + 1 } },
        artifacts: [
          { artifactId: uuidv4(), name: 'result', parts: [{ kind: 'data', data: { a2ui: [], result: { step } } }] },
        ],
      })
    }
    bus.finished()
  }

  cancelTask = async (): Promise<void> => {}
}

/**
 * Поднимает 0.3-агента на случайном порту. `hybridCard` — карточка ts-host 0.1.0-alpha.46+ (поля
 * 0.3 + `supportedInterfaces` с версией 0.3); без него — чистая карточка 0.3 (внешний агент).
 */
export async function startV03Server(opts: { hybridCard: boolean }): Promise<V03Server> {
  const seen: IncomingHttpHeaders[] = []
  const app = express()
  app.use(express.json())
  const server: Server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}`
  const endpoint = `${url}/a2a/v1`
  const card: AgentCard = {
    name: 'v03 wizard',
    description: 'agent on @a2a-js/sdk 0.3',
    version: '0.0.1',
    url: endpoint,
    protocolVersion: '0.3',
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'wizard', name: 'wizard', description: 'd', tags: [] }],
  }
  const publicCard = opts.hybridCard
    ? { ...card, supportedInterfaces: [{ url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: '0.3' }] }
    : card
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new WizardV03())
  app.get('/.well-known/agent-card.json', (_req, res) => {
    res.json(publicCard)
  })
  app.use(
    '/a2a/v1',
    (req, _res, next) => {
      seen.push(req.headers)
      next()
    },
    jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }),
  )
  return {
    url,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
