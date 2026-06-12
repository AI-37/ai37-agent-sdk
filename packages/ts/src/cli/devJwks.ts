// dev-jwks: локальный JWKS-сервер для Уровня 2a (реальная верификация подписи без внешнего провайдера).
import { createServer, type Server } from 'node:http'
import { loadOrCreateDevKey } from './devKey'

export interface DevJwksServer {
  server: Server
  port: number
  url: string
  close(): Promise<void>
}

export async function startDevJwks(
  opts: { port?: number; keyFile?: string } = {},
): Promise<DevJwksServer> {
  const key = await loadOrCreateDevKey(opts.keyFile)
  const body = JSON.stringify(key.jwks)

  const server = createServer((req, res) => {
    if (req.url === '/jwks' || req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not_found' }))
  })

  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 0, resolve),
  )
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0)

  return {
    server,
    port,
    url: `http://localhost:${port}/jwks`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
