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

## База проекта: пул проекта в document-service

Фоновая задача (отчёт по расписанию) грузит файл в пул проекта DS от служебного клиента Authentik;
токен кэшируется до истечения, организацию DS берёт из записи пула:

```python
from ai37_agent_host import ProjectPoolError, service_token, upload_to_project_pool

bearer = await service_token(issuer=ISSUER, client_id=CLIENT_ID, client_secret=CLIENT_SECRET)
try:
    res = await upload_to_project_pool(
        document_service_url=DS_URL, project_key=project_id, file=Path(report), file_name=name,
        bearer=bearer,
    )
    series_id = res.series_id or res.duplicate_of.id  # повтор того же файла — не ошибка
except ProjectPoolError as exc:
    ...  # exc.code: pool_not_found, upload_busy (exc.retry_after_seconds), documents_not_in_plan, …
```

`file` — `bytes`, путь (`Path`), открытый бинарный файл или асинхронный поток (тогда `size=`).
Рядом `find_project_document_by_title`, мост chat-backend `index_to_project` и артефакты хода
(`artifact_scope` → `create_attachment_readers(..., artifacts=)`), как в `@ai37/agent-host` 0.4.0.

## Трассировка Langfuse

Ставится extra `observability` (langfuse v5 и OpenTelemetry), включается ключами
`LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` (+ `LANGFUSE_BASE_URL`, `LANGFUSE_TRACING_ENVIRONMENT`):

```bash
pip install "ai37-agent-host[observability]"
```

Хост сам открывает turn-спан на каждый ход, и на A2A (`{service}:a2a`), и на AG-UI. Входящий
`traceparent` продолжает трейс оркестратора. Когниция берёт колбэки через
`current_langfuse_callbacks()` и передаёт их в `invoke`. Оборачивать ход в `with_turn_observability`
самому не нужно: вложенный вызов откроет отдельный трейс. Батч досылается после хода в фоновом потоке, ход его не ждёт.
Содержимое ходов в трейс не пишется, пока не задан `LANGFUSE_CAPTURE_CONTENT=true`. Без пакета или
ключей трассировка выключена, ход идёт как обычно.

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
хранилища нет. Владельца задачи хост кладёт в `ServerCallContext` сам (`owner.py`, `<org_id>:<sub>`
из проверенного JWT) — на A2A- и AG-UI-пути и для любого стора. REST-ручки агента, которые ходят в
стор напрямую, берут контекст через `current_call_context()`. Сверху добавлено:

- **чужую задачу не перезаписать** (`save` → `TaskOwnerError`), не прочитать (`get` → `None`).
  Upstream перезаписывает строку по одному `id` независимо от владельца;
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
