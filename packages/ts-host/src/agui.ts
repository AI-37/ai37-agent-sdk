import { Router, type Request, type Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { currentCtx } from './als'
import type { AgentHandler, AgentInput, Ai37Metadata } from './types'

/**
 * Минимальный AG-UI SSE-адаптер: тот же `AgentHandler`, что и A2A, со стримом
 * событий. Полный CopilotKit/AG-UI-мост (типы событий, HITL-формы) — позже.
 */
export function aguiRouter(handler: AgentHandler): Router {
  const r = Router()

  r.post('/', async (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    const ctx = currentCtx()
    const body = (req.body ?? {}) as {
      text?: string
      data?: Record<string, unknown>
      ai37?: Ai37Metadata
    }

    const input: AgentInput = {
      text: body.text,
      data: body.data ?? {},
      metadata: body.ai37 ?? {},
      claims: ctx?.claims,
      billingOrgId: ctx?.billingOrgId,
      taskId: uuidv4(),
      contextId: uuidv4(),
    }

    try {
      const result = await handler.run({
        input,
        ctx,
        emit: (e) => send(e.type, e),
      })
      if (result.status === 'input-required' && result.followup) {
        send('a2ui_render', result.followup)
      }
      for (const c of result.a2ui ?? []) send('a2ui_render', c)
      send('done', { status: result.status, message: result.message })
    } catch (e) {
      send('error', { message: String(e) })
    } finally {
      res.end()
    }
  })

  return r
}
