# Changelog — ai37-agent-host (Python)

Формат: [Keep a Changelog](https://keepachangelog.com/). Версия — `pyproject.toml` этого пакета;
публикуется в PyPI независимо от TS-пакетов. Файл заведён с `0.1.0a17`: до него чейнджлога
у пакета не было, ранние версии описаны только в истории коммитов.

## [0.1.0a19] - 2026-10-07

### Added

- `ai37_agent_host.postgres_task_store.PostgresTaskStore` — durable A2A `TaskStore` на Postgres
  поверх upstream `a2a.server.tasks.DatabaseTaskStore` (extra `postgres`: `sqlalchemy[asyncio]` +
  `asyncpg`). Сверху upstream: владелец из проверенного JWT (`jwt_owner_resolver`,
  отказ записать чужую задачу (`TaskOwnerError`), неизменяемость завершённой задачи,
  `assert_ready()`, ретенция `cleanup()`. Таблица по умолчанию `a2a_tasks`.
- `migrate_postgres_task_store()` и CLI `python -m ai37_agent_host.postgres_task_store
  migrate|cleanup` (читает `DATABASE_URL`) для Helm-хука и CronJob.

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
