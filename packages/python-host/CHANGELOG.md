# Changelog — ai37-agent-host (Python)

Формат: [Keep a Changelog](https://keepachangelog.com/). Версия — `pyproject.toml` этого пакета;
публикуется в PyPI независимо от TS-пакетов. Файл заведён с `0.1.0a17`: до него чейнджлога
у пакета не было, ранние версии описаны только в истории коммитов.

## [0.1.0a23] - 2026-10-09

Паритет с `@ai37/agent-host` `0.1.0-alpha.50`: guard'ы закрываются при сбое проверки так же, как в TS.

### Security

- `AuthGuardMiddleware` и `McpChallengeGuardMiddleware` при `required=True` отвечают **503** на
  сбой проверки, который не является `AuthError`. Это `BillingConfigurationError` при пустом
  `billing.apps_auth_token`, сбой introspection или JWKS вне `AuthError`, баг верификатора. Тело
  ответа без деталей: для A2A и AG-UI `{"error": "auth_unavailable"}`, для MCP JSON-RPC `-32603`
  без `WWW-Authenticate`. Downstream не вызывается. Анонимного прохода здесь и раньше не было:
  исключение всплывало из middleware, и сервер отдавал сырой 500 без метрики.
  `AuthError` → 401, как раньше.

### Added

- Метрика `ai37_agent_auth_guard_errors_total{service}`. Причина пишется в лог
  `ai37_agent_host.auth_guard` (уровень ERROR). Токен запроса, `Bearer …` и JWT из сообщения
  вырезаются, длина ограничена 200 символами.
- `McpChallengeGuardMiddleware(service=...)` и `MountMcpOptions.service` для лейбла метрики.

### Changed

- При `required=False` сбой проверки, который не является `AuthError`, пропускает запрос без
  ctx, как в TS. Раньше был 500. Доступа это не расширяет: при `required=False` запрос без
  токена и так проходит анонимом.

## [0.1.0a22] - 2026-10-08

### Added

- `publish_artifact(...)` — зеркало `publishArtifact` из `@ai37/agent-host` `0.1.0-alpha.48`.
  Публикует результат хода в выходную полку chat-backend (`POST /api/artifacts`, план
  files-and-artifacts-layer §3.3) от имени пользователя: user-JWT и диалог берутся из request-scope
  хода. Без них бросает `ArtifactPublishError("no_scope")` и запрос не отправляет. Ключ
  идемпотентности по умолчанию считается тем же алгоритмом, что в TS, и даёт тот же результат
  (в тестах это проверено общим вектором). Все поля уходят одним multipart: без файлов httpx
  отправил бы urlencoded, а markdown — как есть, без CRLF. Ошибки — те же коды, что в TS.
- `ArtifactsStoreBackend` — read-only StoreBackend по корпусу диалога (`{"contextId": …}`) или
  проекта (`{"projectId": …}`). Поддержаны `ls`, `read` окнами, FTS-`grep` и `glob`.
  `read_raw("/<id>/<fileId>")` и `read_file(id, file_id)` отдают байты файла артефакта, а
  `write`/`edit` возвращают ошибку.
- `current_turn_context()` → `HostTurn(context_id, task_id)`. A2A-executor и AG-UI-роутер
  кладут их в scope до вызова handler'а, независимо от трассировки.
- `context_file_path` разбирает `artifact:<id>` и `project-artifact:<id>`.

## [0.1.0a21] - 2026-10-08

### Fixed

- `PostgresTaskStore.assert_ready()` и `migrate_postgres_task_store()` (CLI `migrate`) сверяют
  колонки таблицы с моделью задачи, а не только её имя. Раньше чужая таблица с тем же именем
  (у Минстроя — старая `a2a_tasks` от первого A2A-транспорта) проходила обе проверки: `migrate`
  молча пропускал `CREATE TABLE` и при этом расширял её `id`/`context_id`, под стартовал зелёным,
  а падал на первом `tasks/get`. Теперь обе падают с `not an A2A task table (missing columns …)`
  до любых изменений схемы; CLI выходит с кодом 1 и сообщением вместо трейсбека.

## [0.1.0a20] - 2026-10-07

### Fixed

- MCP-эндпоинт (`/mcp`) отвечает `405 Method Not Allowed` + `Allow: POST` на всё, кроме POST
  (паритет с TS `@ai37/agent-host` `0.1.0-alpha.47`). Stateless-серверу нечего слать в
  сервер-инициированный SSE, а SDK на GET открывал standalone-стрим с пингами, который жил,
  пока клиент не уйдёт, и держал задачу сервера.

## [0.1.0a19] - 2026-10-07

### Added

- `ai37_agent_host.postgres_task_store.PostgresTaskStore` — durable A2A `TaskStore` на Postgres
  поверх upstream `a2a.server.tasks.DatabaseTaskStore` (extra `postgres`: `sqlalchemy[asyncio]` +
  `asyncpg`). Сверху upstream: владелец из проверенного JWT (`jwt_owner_resolver`,
  отказ записать чужую задачу (`TaskOwnerError`), неизменяемость завершённой задачи,
  `assert_ready()`, ретенция `cleanup()`. Таблица по умолчанию `a2a_tasks`.
- `migrate_postgres_task_store()` и CLI `python -m ai37_agent_host.postgres_task_store
  migrate|cleanup` (читает `DATABASE_URL`) для Helm-хука и CronJob.

- `id`/`context_id` задачи шире upstream: миграция расширяет обе колонки до `varchar(255)`
  (`MAX_ID_LENGTH`), `assert_ready()` проверяет ширину, id длиннее отклоняется как
  `InvalidParams`, а не 500 от БД. Upstream объявляет их `String(36)`, а `Thread.contextId`
  chat-backend до сих пор бывает `th_<uuid>` (39) — первый же `save` такого треда падал бы.
- `owner.py`: `current_user()` / `current_call_context()` / `HostCallContextBuilder` —
  пользователь хода из проверенного JWT (`JwtUser`, `user_name` = `<org_id>:<sub>`).

### Fixed

- **Задачи разных пользователей не были разведены.** Аутентификацию делает
  `AuthGuardMiddleware` (ContextVar), а не Starlette `request.user`, поэтому `a2a-sdk` клал в
  `ServerCallContext` анонимного пользователя с пустым именем, а AG-UI-путь передавал пустой
  контекст. Все сторы (`InMemoryTaskStore`, `RedisTaskStore`, `DatabaseTaskStore`) разводят задачи
  по `context.user.user_name`, так что все задачи всех пользователей лежали под одним владельцем:
  `tasks/get` по чужому `taskId` отдавал чужую задачу. Теперь `create_agent_host` передаёт в
  JSON-RPC и REST маршруты `HostCallContextBuilder`, а AG-UI собирает контекст через
  `current_call_context()`, и владелец на обоих путях один и тот же.

  **При выкатке:** у `RedisTaskStore` владелец входит в ключ (`{prefix}{owner}:{task_id}`), поэтому
  задачи, поставленные на паузу (`input-required`) до обновления, после него не найдутся: их
  нужно довести до конца до деплоя или принять, что пользователь начнёт заново. Без JWT
  (`AI37_AUTH_REQUIRED=false`) владелец пустой, как раньше.

### Notes
- Upstream `create_task_model(table_name)` регистрирует модель в общем `MetaData` при каждом
  вызове, второй `DatabaseTaskStore` на ту же кастомную таблицу в процессе падал. Модель
  кешируется по имени таблицы.

## [0.1.0a18] - 2026-09-24

### Fixed

- `_read_prior_state` отдаёт ПОСЛЕДНЕЕ сохранённое состояние, а не первое. Артефакты задачи
  копятся за диалог, и перебор сверху вниз возвращал состояние самого первого хода на всю жизнь
  задачи: агент не видел ничего из того, что записал позже сам.

  Прод 24.09.2026, minstroy: агент на каждом ходе получал `{"phase": "awaiting-signature"}` от
  первого сообщения, не находил `bulkTaskId` уже идущего прогона и запускал второй — по тому же
  файлу и со вторым списанием. Защита от дубля в агенте была написана и работала, ей просто
  нечего было читать.

  Держится фикс на инварианте: позиция артефакта в списке означает свежесть, потому что
  артефакты состояния дописываются в хвост. Поэтому `input-required` и `working` намеренно
  остаются БЕЗ закреплённого `artifact_id`: с ним менеджер задач заменял бы артефакт на месте,
  по старому индексу, и ход `input-required → working → input-required` оставил бы свежее
  состояние в начале списка, а устаревшее — в конце. Ограничить рост списка нужно отдельным
  слотом состояния — это меняет то, что уезжает на провод, и просится отдельным разбором.

  `@ai37/agent-host` (TS) этого дефекта не имеет и не бампается: persist-state он держит в одном
  перезаписываемом слоте `task.metadata.state`, а не в списке артефактов. Контракт не менялся —
  расходилась только питоновская реализация.

## [0.1.0a17] - 2026-09-24

### Added

- `host_metrics_registry` и `service_label` в публичном API. Сервис на этом хосте кладёт свою серию
  в тот же `/metrics`, а лейбл `service` считает той же функцией, что и `ai37_agent_*`, — иначе
  серии сервиса не свести с хостовыми одним запросом.

  В отличие от TS-хоста это не открывает новой механики: `create_agent_host` монтирует
  `make_asgi_app()` без аргумента, то есть глобальный default-реестр `prometheus_client`, и метрика,
  созданная где угодно в процессе, попадала туда и раньше. Экспорт фиксирует контракт явно —
  сервис пишет `registry=host_metrics_registry` вместо молчаливого расчёта на глобальный реестр
  и переживёт переход хоста на собственный. Парити с TS `@ai37/agent-host@0.1.0-alpha.45`.
