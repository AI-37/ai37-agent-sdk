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

## Durable A2A TaskStore на Postgres

По умолчанию `create_agent_host` держит задачи в `InMemoryTaskStore`: пауза `input-required`
теряется при рестарте и не видна другой реплике. Для прода — `PostgresTaskStore` из
`ai37_agent_host.postgres_task_store` (extra `postgres`):

```bash
pip install "ai37-agent-host[postgres]"
```

```python
from ai37_agent_host import create_agent_host
from ai37_agent_host.postgres_task_store import PostgresTaskStore, create_engine

store = PostgresTaskStore(create_engine(os.environ["DATABASE_URL"]))
await store.assert_ready()  # на старте: без миграции под падает сразу, а не на первом ходе
app = create_agent_host(card=..., handler=..., agent_context=..., task_store=store)
```

Это тонкая обёртка над upstream `a2a.server.tasks.DatabaseTaskStore` (SQLAlchemy async), своего
хранилища нет. Сверху добавлено:

- **владелец из проверенного JWT** (`<org_id>:<sub>` из `AgentContext` хода): чужой пользователь
  задачу не прочитает (`get` → `None`) и не перезапишет (`save` → `TaskOwnerError`). Upstream
  перезаписывает строку по одному `id` независимо от владельца;
- **завершённая задача не перезаписывается** (completed/failed/canceled/rejected);
- **схема — шагом деплоя**: таблицу `a2a_tasks` создаёт Job, под таблицу не создаёт;
- **ретенция** `cleanup(terminal_retention_days=..., stale_retention_days=...)`.

CLI для Helm-хука `pre-install,pre-upgrade` и CronJob (строка подключения только из `DATABASE_URL`,
`postgres://` автоматически переводится на драйвер asyncpg):

```bash
DATABASE_URL=postgres://... python -m ai37_agent_host.postgres_task_store migrate
DATABASE_URL=postgres://... python -m ai37_agent_host.postgres_task_store cleanup \
  --terminal-days 7 --stale-days 30
```

Будущие изменения схемы upstream выпускает Alembic-миграциями: `a2a-db upgrade --tasks-table
a2a_tasks` из `a2a-sdk[db-cli]`.
