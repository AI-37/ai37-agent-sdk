# ai37-agent-host (Python)

Host-слой A2A-агентов экосистемы **AI37** (Python). Порт TS-пакета `@ai37/agent-host`
поверх официального **`a2a-sdk`** (Starlette) и базового **`ai37-agent-sdk`** (auth/billing/context).

Разработчик агента реализует **один** контракт `AgentHandler.run(req) -> AgentResult` и вызывает
`create_agent_host(...)`, а host даёт весь транспорт (A2A JSON-RPC/REST, AG-UI SSE, опц. MCP),
JWT-guard, content-negotiation A2UI, file-aware store-backends и Langfuse-трассировку.

> Base-SDK (`ai37-agent-sdk`) — синхронный; host — async. На стыке billing/auth sync-вызовы
> оборачиваются в `anyio.to_thread.run_sync`, чтобы не блокировать event-loop.

## Статус

Порт в работе (Фаза 2). Готово:

- `types` — контракты (`AgentHandler`/`AgentInput`/`AgentEvent`/`AgentResult`/`ContextFile`/`A2uiComponent`/…);
- `als` — request-scope на `contextvars` (`current_ctx`/`current_bearer`/`current_supported_catalog_ids`/…).

В работе: `parse`, `build_task`, `a2a_executor`, `auth_guard`, `output_modes`, `a2ui`,
`create_agent_host`, `store_backend` (+`read_raw`), `agui`, `mcp`, `relay`, `observability/langfuse`.
