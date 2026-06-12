// dev-billing: стаб billing-microservice для Уровня 2b. Отдаёт фикстуру runtime state,
// принимает usage, отдаёт записанный usage на /__debug/usage. ТОЛЬКО для разработки/тестов.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { fixtures } from '../testing/fixtures'
import { BillingFeatureCode, BillingPrivilegeCode } from '../codes'
import type { BillingRuntimeState } from '../billing/types'

export type FixtureName =
  | 'active'
  | 'no_resources'
  | 'trial'
  | 'feature_allowed'
  | 'feature_denied'

export function resolveFixture(name: FixtureName): BillingRuntimeState {
  switch (name) {
    case 'no_resources':
      return fixtures.runtimeState.no_resources()
    case 'trial':
      return fixtures.runtimeState.trial()
    case 'feature_allowed':
      return fixtures.runtimeState.feature_allowed(
        BillingFeatureCode.ElevatorCalcAgent,
        BillingPrivilegeCode.ElevatorCalcAllowed,
      )
    case 'feature_denied':
      return fixtures.runtimeState.feature_denied(
        BillingFeatureCode.ElevatorCalcAgent,
        BillingPrivilegeCode.ElevatorCalcAllowed,
      )
    default:
      return fixtures.runtimeState.active()
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })
}

export interface DevBillingServer {
  server: Server
  port: number
  baseUrl: string
  usage: unknown[]
  close(): Promise<void>
}

export async function startDevBilling(
  opts: { port?: number; fixture?: FixtureName } = {},
): Promise<DevBillingServer> {
  const state = resolveFixture(opts.fixture ?? 'active')
  const usage: unknown[] = []

  const server = createServer(async (req, res) => {
    const url = req.url ?? ''
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }

    if (req.method === 'GET' && /\/state$/.test(url)) {
      const m = /by-billing-org\/([^/]+)\/state$/.exec(url)
      const billingOrgId = m ? decodeURIComponent(m[1]) : state.billingOrgId
      json(200, { ...state, billingOrgId })
      return
    }
    if (req.method === 'POST' && url.endsWith('/api/v1/events')) {
      const body = await readBody(req)
      try {
        usage.push(JSON.parse(body))
      } catch {
        usage.push(body)
      }
      json(200, { accepted: true })
      return
    }
    if (req.method === 'GET' && url.endsWith('/__debug/usage')) {
      json(200, usage)
      return
    }
    json(404, { error: 'not_found' })
  })

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0)

  return {
    server,
    port,
    baseUrl: `http://localhost:${port}`,
    usage,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
