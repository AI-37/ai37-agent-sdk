import type { Request, Response } from 'express'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentContext } from '@ai37/agent-sdk'
import { currentCtx } from '../als'
import type { McpOptions, McpToolDef } from './types'

/**
 * Собирает `McpServer` из набора tool-определений. `ctx` (кто вызвал) прокидывается в каждый
 * handler. `@modelcontextprotocol/sdk` и `zod` подгружаются ДИНАМИЧЕСКИ — это делает их
 * optional-peer'ами: потребители agent-host, не использующие `mcp`, их не тянут. Без ALS —
 * чтобы переиспользовать и вне agent-host (напр. в NestJS rag-factory со своим guard'ом).
 */
export async function buildMcpServer(
  serverInfo: { name: string; version: string },
  tools: McpToolDef[],
  ctx: AgentContext | undefined,
): Promise<McpServer> {
  const [{ McpServer: McpServerCtor }, { z }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/mcp.js'),
    import('zod'),
  ])
  const defaultInputSchema = {
    query: z.string().describe('Запрос на естественном языке'),
  }
  const server = new McpServerCtor({
    name: serverInfo.name,
    version: serverInfo.version,
  })
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.inputSchema ?? defaultInputSchema,
      },
      async (args: Record<string, unknown>) => {
        const result = await t.handler(args, ctx)
        // McpToolResult — подмножество CallToolResult; форма совпадает.
        return result as Awaited<
          ReturnType<Parameters<McpServer['registerTool']>[2]>
        >
      },
    )
  }
  return server
}

/**
 * Express-handler MCP-эндпоинта (StreamableHTTP, stateless: новый server+transport на запрос —
 * это и позволяет chat-backend отдавать НАБОР ПО ПОЛЬЗОВАТЕЛЮ). `ctx` берётся из ALS
 * (`mcpChallengeGuard` его туда положил), tools резолвятся статически или per-request.
 */
export function mcpHttpHandler(
  opts: McpOptions,
  serverInfo: { name: string; version: string },
) {
  return async (req: Request, res: Response): Promise<void> => {
    const ctx = currentCtx()
    const resolved =
      typeof opts.tools === 'function' ? await opts.tools(ctx) : opts.tools
    // Резолвер мог вернуть либо список, либо { tools, release } (занял ресурсы на запрос).
    const tools = Array.isArray(resolved) ? resolved : resolved.tools
    const release = Array.isArray(resolved) ? undefined : resolved.release

    const server = await buildMcpServer(serverInfo, tools, ctx)
    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    )
    // Stateless: без sessionId (сервер-инициированный SSE не нужен, запросы независимы).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
      if (release) void release()
    })
    await server.connect(transport)
    // express.json() уже распарсил тело → передаём его третьим аргументом.
    await transport.handleRequest(req, res, req.body)
  }
}
