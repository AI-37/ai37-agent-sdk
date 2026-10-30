# Changelog — ai37-agent-host (Python)

Формат: [Keep a Changelog](https://keepachangelog.com/). Версия — `pyproject.toml` этого пакета;
публикуется в PyPI независимо от TS-пакетов. Файл заведён с `0.1.0a17`: до него чейнджлога
у пакета не было, ранние версии описаны только в истории коммитов.

## [0.1.0a27]

Паритет с `@ai37/agent-host` 0.3.0 по сборке файлов хода (срез 0a плана
`docs/plans/search-agent-chat-attachments.md`).

### Added
- `attachment_scope(context_id, context_refs, context_files)`, `has_file_refs`,
  `project_id_from_refs` и dataclass'ы `AttachmentFile` / `AttachmentTurnScope` в
  `ai37_agent_host.store_backend`. Читатели (`Chat/ProjectAttachmentsStoreBackend`) у python-хоста
  уже есть, извлечение одним вызовом ему пока никто не заказывал.

## [0.1.0a26]

Наблюдаемость A2A-хода. Нашлось 29.10 в prod Полиметрики, когда агент данных включил Langfuse
(AI-37/polimetrika-data-agent#8): трейсов A2A-ходов не было вовсе, а обход пришлось писать в агенте.

### Added
- **Turn-спан на A2A-ходе.** `HostExecutor` оборачивает ход в `with_turn_observability`, как
  AG-UI-роутер и как ts-host: спан `{service}:a2a`, `session_id=contextId`, `user_id=claims.sub`.
  Входящий `traceparent` из `message.metadata` продолжает трейс оркестратора, без него берётся
  `metadata.ai37.trace_id`. Раньше на A2A `current_langfuse_callbacks()` возвращал `[]` даже с
  пакетом и ключами, и граф агента ничего не писал. Агентам, которые оборачивали ход сами
  (`_traced` в polimetrika-data-agent), обёртку надо убрать в том же PR, где поднимают хост: иначе
  вложенный вызов откроет второй turn-спан корнем отдельного трейса, и спаны графа уйдут туда.
- **Extra `observability`**: `pip install "ai37-agent-host[observability]"` ставит
  `langfuse>=5.0,<6`. Именно v5: в v3/v4 `langfuse.langchain` импортирует полный пакет `langchain`,
  и у агентов только с `langchain-core` `CallbackHandler` молча не создавался.

### Fixed
- **Ход агента встаёт в трейс оркестратора.** a2a-sdk при установленном OpenTelemetry сам открывает
  SERVER-спан на запрос, а Langfuse такие спаны не экспортирует. Turn-спан без явного родителя
  вешался под него и получал отдельный trace с `parentObservationId`, которого нет ни в одном
  трейсе (prod Полиметрики 29.10: оркестратор в `92d4…`, агент в `3b0e…`). Теперь родитель —
  спан `remote-a2a:<agent>` из входящего `traceparent`; без `traceparent` и `metadata.ai37.trace_id`
  ход становится корнем своего трейса, как и обещал докстринг модуля. Битый `traceparent`
  родителем не считается. `parse_a2a_message` читает из `message.metadata` ещё и `baggage`, как
  `readTraceCarrier` в ts-host.
- **`flush` после хода больше не блокирует event loop.** `Langfuse.flush()` синхронный (OTel
  `force_flush` и `join()` очередей), и при деградации Langfuse вставали все запросы процесса, включая
  REST. Теперь он идёт в фоновом потоке-демоне, ход его не ждёт, одновременно идёт не больше одного
  flush. Ошибка flush пишется в лог и ход не роняет. Остаток батча экспортирует `BatchSpanProcessor`
  по расписанию и клиент при выходе процесса.
- **В `propagate_attributes` уходят только заданные поля.** Ключи метаданных хода со значением
  `None` (intent, channel, tenant…) давали в langfuse 5 WARNING «Propagated attribute … is None» до
  пяти раз за ход. Заодно контекст `propagate_attributes` теперь закрывается с концом хода, а не
  остаётся открытым.

## [0.1.0a25]

Паритет с `@ai37/agent-host` `0.2.6`: LLM-клиент под шлюз LiteLLM с лимитами провайдера.

### Changed
- **`create_openai_client` / `resolve_llm_config`: 180 с на попытку, один повтор, без повтора 429.**
  Было 30 с и 3 повтора: 30 с короче ожидания шлюза (он выжидает `Retry-After` провайдера до
  2 × 60 с), а повтор 429 снова вставал в очередь лимита. Клиент — сабкласс `AsyncOpenAI`, у
  которого `_should_retry` отвечает «нет» на 429 и в остальном зовёт исходный метод SDK.

### Added
- **Heartbeat AG-UI** (`AGUI_HEARTBEAT_S = 15`): после 15 с тишины в поток уходит `: ping`.
- **Keepalive A2A** (`A2A_KEEPALIVE_S = 20`): после 20 с тишины хода — `status-update working` без
  metadata. `A2aProgress` получил необязательный `keepalive_s`; `HostExecutor` его включает.
- **Таймауты relay:** `RemoteA2aRequest.idle_timeout_ms` и `request_timeout_ms` — `TimeoutError` с
  понятным текстом; поток при простое закрывается.
- **Отмена хода.** `HostExecutor.cancel` публикует `canceled` (сам ход a2a-sdk уже прервал через
  `CancelledError` — питоновский аналог `AgentRequest.signal`; раньше задача оставалась `working`).
  Обрыв потока AG-UI отменяет задачу хода, а не доигрывает её. Relay при отмене вызова или таймауте
  шлёт агенту `tasks/cancel` по id задачи.

## [0.1.0a24] - 2026-10-09

Паритет с `@ai37/agent-host` `0.2.5`: содержимое хода не уходит в Langfuse без явного разрешения.

### Security

- **Маска содержимого Langfuse.** Клиент `Langfuse` создавался без маски, и при установленном
  `langfuse` в трейс уходили промпты и ответы модели (`CallbackHandler` из langchain) и выход хода
  как есть. Теперь, как в ts-host, по умолчанию действует `langfuse_content_mask`: содержимое
  заменяется меткой `{"redacted": true, "chars": N}`, служебная метаданная хода (`trace.v1`)
  проходит как есть. Включить захват содержимого — `LANGFUSE_CAPTURE_CONTENT=true`, только там, где
  Langfuse в своём контуре и у обработки содержимого есть правовое основание.
- `payloadMode` turn-спана честно показывает `redacted`, когда текст хода есть, а захват выключен.

## [0.1.0a23] - 2026-10-09

Паритет с `@ai37/agent-host` `0.2.3`: guard'ы закрываются при сбое проверки так же, как в TS.

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
