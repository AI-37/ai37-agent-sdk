# ai37-agent-sdk

<!-- ai37:card:start (managed by doc-bot — do not edit inside) -->
# ai37-agent-sdk

## Описание

SDK для агентов экосистемы AI37: закрывает сквозные задачи auth (верификация user-JWT по JWKS), billing (runtime state по `billing_org_id` и по `org_id` через маршруты `by-billing-org` / `by-org`, metered usage, `llmKey`, гейт отказа по `entitlementStatus`, включая `payment_failed`), A2A-forward того же user-JWT и обёртку `AgentContext`. Это монорепо двух реализаций (TypeScript и Python) с общим контрактом плюс host-слой агентов (`@ai37/agent-host`): поверх SDK хост добавляет A2A/AG-UI/MCP-сервер, JWT-guard, генерик-механизм скиллов (subpath `@ai37/agent-host/skills`) и шов durable LangGraph-чекпоинтера. TS-хост стоит на `@a2a-js/sdk` ^1.3.0 и по умолчанию принимает клиентов A2A 0.3 (`legacyCompat`): запрос без заголовка `A2A-Version` или с `0.3` идёт в compat-слой, с `1.0` — в обработчик 1.x, а публичная Agent Card гибридная (поля 0.3 верхнего уровня + `supportedInterfaces`, где JSON-RPC объявлен версиями `1.0` и `0.3`). Форма `input-required` уезжает data-частью `{ a2ui: [...] }` в `status.message`, рядом с текстом паузы; копия формы в артефакте `a2ui-<taskId>` кладётся только пока включён `legacyCompat`. Хост явно очищает то, что прошлый ход оставил, а этот не дал (форму прошлого шага, артефакт стримового текста прошлого хода `answer-<taskId>` и `metadata.state`), потому что сервер 1.x мёржит задачу с сохранённой. Relay (`@ai37/agent-host/relay`) работает клиентом 1.x с compat 0.3 и фабрикой `createAi37ClientFactory(fetchImpl?)`; `extractA2ui` читает форму в порядке `status.message` → артефакт `a2ui-<taskId>` → `metadata.a2ui`.

Host сам включает Langfuse-трассировку, но по умолчанию содержимое хода в трейс не пишется: только структура, тайминги, идентификаторы и объёмы. Обе реализации ставят на клиента Langfuse маску содержимого (`langfuseContentMask` в TS, `langfuse_content_mask` в Python) — она закрывает и спаны, которые строит `langchain`-`CallbackHandler`, а служебная метаданная хода (`trace.v1`) проходит её как есть; содержимое заменяется меткой `{"redacted": true, "chars": N}` (в TS — строкой JSON, потому что атрибут спана OpenTelemetry примитивен). В Python-хосте (`ai37-agent-host` `0.1.0a26`) turn-спан открывается и на A2A-ходе (`{service}:a2a`), как на AG-UI и в ts-host: входящий `traceparent` продолжает трейс оркестратора, без него берётся `metadata.ai37.trace_id`, а ход без родителя становится корнем своего трейса — собственный SERVER-спан `a2a-sdk`, который Langfuse не экспортирует, родителем больше не считается. Колбэки когниции приходят через `current_langfuse_callbacks()`, `flush` после хода идёт в фоновом потоке-демоне, а в `propagate_attributes` уходят только заданные поля. В `ai37-agent-host` `0.1.0a25` — паритет с `@ai37/agent-host` `0.2.6`: LLM-клиент с 180 с на попытку и одним повтором без повтора 429, heartbeat AG-UI (`AGUI_HEARTBEAT_S = 15`), keepalive A2A (`A2A_KEEPALIVE_S = 20`), таймауты relay (`idle_timeout_ms`/`request_timeout_ms` → `TimeoutError`), отмена хода публикует `canceled`.

В `@ai37/agent-host` `0.3.0` и `ai37-agent-host` `0.1.0a27` появились «файлы хода» без виртуальной ФС: `attachmentScope` / `attachment_scope` детерминированно собирает список файлов хода из `context_refs` и манифеста `context_files` (LLM в выборе путей не участвует), читатели TS-хоста читают файлы по ref окнами и ищут по обеим полкам chat-backend, `readAttachmentContents` укладывает тексты всех файлов в общий бюджет символов, а `extractFromAttachments` делает извлечение одним LLM-вызовом вместо многоитерационного deepagent'а с виртуальной ФС. В python-хосте портирована только сборка скоупа: читатели и извлечение не заказаны.

В `@ai37/agent-host` `0.4.0` к файлам хода добавились артефакты и появилась «база проекта» (план `docs/plans/project-knowledge-bridge.md`, срез 2). `artifactScope({ chatBackendUrl, contextId, projectId?, bearer? })` загружает корпус артефактов треда (`artifact:<id>`) и проекта (`project-artifact:<id>`) через `ArtifactsStoreBackend.list()`; `createAttachmentReaders({ ..., artifacts })` читает, ищет и кладёт их в `readAttachmentContents` наравне с вложениями с той же охраной — ref не из загруженного списка не читается и в сеть не уходит, а у файлов из артефактов `AttachmentFile.kind: 'artifact'` (у вложений поля нет). Загрузчик в пул проекта document-service один на всех: `uploadToProjectPool` шлёт файл телом без multipart (`X-File-Name`, `X-Project-Name`, `Content-Length`; поток — полудуплексом) на `POST /api/project-pools/{projectKey}/documents` и возвращает `{ seriesId }`, а повтор того же содержимого (409 `duplicate`) — `{ duplicateOf: { id, title } }`; отказы — `ProjectPoolError` с кодом DS из тела (`pool_not_found`, `ambiguous_project_pool`, `documents_not_in_plan`, …), у `upload_busy` ещё `retryAfterSeconds` из `Retry-After`. `findProjectDocumentByTitle` находит документ пула по точному названию (DS ищет подстрокой, SDK сверяет название целиком и листает страницы по `nextCursor`) или отдаёт `null`. Для фоновых задач без пользователя есть `serviceToken({ issuer, clientId, clientSecret, scope? })` — токен `client_credentials` (не OIDC-логин и не обмен токена пользователя): `token_endpoint` из discovery issuer'а, токен живёт в памяти процесса до истечения с запасом (минута, у короткоживущих — половина срока), параллельные вызовы ждут один запрос, ошибки — `ServiceTokenError`. Мост «добавить в базу проекта» — `indexToProject({ chatBackendUrl, projectId, refs, bearer? })` поверх chat-backend `POST /api/project-knowledge`: результат по каждому ref — `sent` (с `seriesId`), `already_indexed`, `not_indexable` (с `reason`), `busy` (с `retryAfterSeconds`) или `rejected` с кодом (`access_grant`, `project_private`, `role_forbidden`, …); отказ запроса целиком — `ProjectKnowledgeError`. Существующие сигнатуры не менялись: без `artifacts` читатели работают как в 0.3.1.

Стриминг в A2A-пути нативный: `AgentEvent.text` уезжает `artifact-update`-дельатами одного стабильного артефакта до завершения handler-а, а терминальный Task сохраняет полный канонический ответ. MCP-экспорт агента следует контракту инструмента: у каждого выставленного наружу инструмента обязателен человекочитаемый `title` плюс опциональные хинты поведения (`annotations`). Манифест вложений `ContextFile` (`metadata.ai37.context_files`) несёт опциональные `mime` и `hasRaw` (`mime`/`has_raw` в Python). В модуле `a2a` объявлены два расширения Agent Card: routing/v1 — компактный семантический профиль для реестра, и showcase/v1 — витринные данные агента для каталога продукта (включая список режимов-плиток `capabilities[]`; у плитки может быть ссылка на скилл своей карточки полем `skill`, и тогда каталог показывает её только организациям, которые проходят гейт этого скилла `x-ai37.skills[skill].billing` в дополнение к гейту агента). SDK не выполняет OIDC-логин — он проверяет и форвардит уже выданный токен. Плюс общеэкосистемные хелперы: единый разбор политики, объявленной переменной окружения (`policy` / `policy::state`). В python-хосте A2A-задачи можно держать в durable Postgres-сторе — `PostgresTaskStore` (extra `postgres`) поверх upstream `DatabaseTaskStore`, с владельцем задачи из проверенного JWT и ретенцией; в TS-хосте — `Ai37TaskStore` (subpath `@ai37/agent-host/task-store`). Версии пакетов публикуются в приватные npm/PyPI, а dist-tag npm-пакетов выводится из версии: пререлиз (`0.1.0-alpha.N`) → `alpha`, релиз (`0.2.0`) → `latest`.

Guard'ы хоста (`jwtGuard`/`mcpChallengeGuard` в TS, `AuthGuardMiddleware`/`McpChallengeGuardMiddleware` в Python) fail-closed: при `required=true` сбой проверки, не являющийся `AuthError` (пустой `billing.appsAuthToken` / `apps_auth_token`, сбой introspection/JWKS вне обёртки `AuthError`, баг верификатора), завершает запрос 503 без деталей, а не пропускает его анонимом; сбой учитывается метрикой `ai37_agent_auth_guard_errors_total{service}` и логом без секретов.

SDK маскирует секреты в логах агентов: `redactForLog(value)` / `redact_for_log(value)` отдаёт копию значения для лога — строковые значения полей, чьё имя подходит под `SECRET_KEY_PATTERN`, заменяются на `[REDACTED]` на любой глубине, а JWT, `Bearer …` и `sk-…` вырезаются из всех строк по виду значения. В TS `agentLoggerOptions({ level, name })` даёт опции pino (pino добавлен только в devDependencies `packages/ts`), в Python `SecretRedactingFilter` (`logging.Filter`) маскирует текст сообщения, аргументы и поля `extra`. `AgentContext.toJSON()` и `util.inspect` (TS) / `log_view()` и `__repr__` (Python) отдают выжимку `AgentContextLogView` — без JWT, ключа LLM, email и клиента биллинга.

В `contract/feature-codes.json` и в коды заведены фича `polimetrika-data-agent` (`BillingFeatureCode.PolimetrikaDataAgent`) и привилегия `polimetrika-data-agent-allowed` (`BillingPrivilegeCode.PolimetrikaDataAgentAllowed`), а также привилегия `pdai-audit-assist-allowed` внутри функции `pdai-doc-152fz`. Регистрация кодов не выдаёт права организациям; паритет TS↔Python проверяется тестами.

В монорепо публикуется также доменный пакет `ai37-capture-contract` — контракт захвата карточки товара для рендереров мониторинга цен (browser-worker minstroy и headed-рендерер вне кластера, `AI-37/website-scraper`): модели `POST /capture-batch` и `GET /health` рендерера, коды причин `REASON_*` и сканер цен в DOM `PRICE_HINTS_JS`. Это не слой SDK: на `contract/`, кодоген и публичный API SDK пакет не влияет.

## Стек

- TypeScript (Node ≥ 22), npm, tsup. Пакеты: `@ai37/agent-sdk` (`0.1.0-alpha.36`), `@ai37/agent-host` (`0.4.0`), `@ai37/docx`.
- Python (≥ 3.11), poetry, ruff, mypy, pytest. Пакеты: `ai37-agent-sdk` (`0.1.0a28`), `ai37-agent-host` (`0.1.0a27`), `ai37-capture-contract` (`0.1.0`).
- Общий контракт в `contract/` (JSON Schema — runtime state, routing/v1 (`a2a-routing-extension.schema.json`), showcase/v1 (`a2a-showcase-extension.schema.json` + общие тест-векторы нормализации `a2a-showcase-extension.vectors.json`), `feature-codes.json`, `env.md`), кодоген `make codegen`. В `feature-codes.json` — коды фич и привилегий биллинга: `daylight-calc-agent`, `document-search-agent`/`document-search-allowed`, `document-service` с привилегией `document-service-max-uploads`, `elevator-calc-agent`, `hvac-calc-agent` (с привилегиями `hvac-air-exchange-allowed` и `hvac-heat-loss-allowed`), `minstroy-agent`/`minstroy-check-inn`, `minstroy-price-monitoring`, `thermal-calc-agent`, `org-limits` (`max-users`, `max-api-keys`), `polimetrika-data-agent`/`polimetrika-data-agent-allowed`, а также PD-AI: `pdai-doc-152fz` (с привилегией `pdai-audit-assist-allowed`), `pdai-doc-187fz`, `pdai-site-check`. Паритет перечислений `BillingFeatureCode`/`BillingPrivilegeCode` с контрактом проверяется тестами обоих SDK (`packages/ts/test/codes.test.ts`, `packages/python/tests/test_codes.py`).
- Host-слой: `packages/ts-host` (`@ai37/agent-host` `0.4.0`, subpaths `./relay`, `./skills`, `./task-store` и `./dsh`) и `packages/python-host` (A2A, AG-UI, MCP, Redis/Postgres task store, observability/Langfuse).
- Файлы хода и артефакты (`@ai37/agent-host` `0.4.0`): модуль `src/attachments/` без новых зависимостей — `attachmentScope` из `context_refs`/`context_files`, `artifactScope` поверх существующего `ArtifactsStoreBackend.list()`, читатели на `Ai37ChatCompletions`, `Chat/Project/Artifacts`-бэкендах и `currentLangfuseCallbacks` из ALS хоста. В python-хосте (`0.1.0a27`) — `store_backend/turn_files.py` на stdlib; читатели, артефакты и извлечение не портированы.
- База проекта (`@ai37/agent-host` `0.4.0`, `src/project-knowledge/`): новых зависимостей нет — глобальный `fetch`, `AbortSignal.timeout`, `node:crypto` (`createHash` для ключа кэша служебного токена) и уже существующий `currentBearer` из ALS.
- A2A: ts-host на `@a2a-js/sdk` ^1.3.0 (сервер 1.x + compat 0.3 по умолчанию, опция `legacyCompat`; dev-зависимость `a2a-sdk-v03` = `npm:@a2a-js/sdk@0.3.13` для тестов), python-host — `a2a-sdk` >=1.1.0. API-совместимость с 0.3 обеспечивают compat-слои SDK (`@a2a-js/sdk/compat/v0_3`, `duplicateInterfacesForLegacy`, `SecurityScheme.fromJSON`).
- MCP-экспорт host-слоя: `@modelcontextprotocol/sdk` + `zod` (TS, optional-peer, динамический импорт) и официальный python `mcp` SDK (optional-группа `mcp`, soft-import с `MissingMcpDependencyError`).
- LangGraph-checkpointer: `@langchain/langgraph-checkpoint` (>=1.1.2) и `@langchain/langgraph-checkpoint-postgres` (>=1.0.0) — optional peers host-слоя, импортируются лениво. `@langchain/openai` (`>=1.0.0`) — optional peer для `Ai37ChatCompletions`.
- Метрики host-слоя: `prom-client` (TS) и `prometheus-client` (Python).
- Durable A2A task store: TS-хоста — `kysely` (`^0.28.17 || ^0.29.0`) + `pg` (`^8`) как optional peerDependencies; python-хоста — `sqlalchemy[asyncio]` (>=2.0) + `asyncpg` (>=0.29), optional extra `postgres`; в dev-группе дополнительно `aiosqlite`.
- Трассировка host-слоя: `@langfuse/otel`, `@langfuse/tracing`, `@opentelemetry/api`, `@opentelemetry/sdk-node`; `@langfuse/langchain` — optionalDependency. В Python — optional extra `observability` (`langfuse>=5.0,<6`, тянет `opentelemetry-sdk` и OTLP-экспортёр), soft-import python `langfuse` SDK (v5, OpenTelemetry) и опциональный `langfuse.langchain.CallbackHandler`; в dev-группе `langfuse>=5.0,<6` для тестов turn-спана на настоящем клиенте.
- AG-UI-транспорт ts-host: `@ag-ui/core` + `@ag-ui/encoder` (`^0.0.57`).
- Обвязка DSH в ts-host: `@ai37/agent-host/dsh` без зависимости от DSH; линт/формат новых модулей — eslint + prettier, проверка распакованного пакета — `scripts/check-dsh-package.mjs`.
- Маскировка секретов в логах SDK: в TS — собственные регулярки, `redactForLog`/`redactSecretsInText` и опции pino `agentLoggerOptions`; `pino` (`^9.14.0`) — только devDependency `packages/ts`. В Python — `logging.Filter` (`SecretRedactingFilter`).
- `ai37-capture-contract` — Python-пакет (`0.1.0`, Python ≥ 3.12, `pydantic>=2`; dev — `pytest`, `mypy`, `ruff`; версия рантайма фиксируется `packages/capture-contract/.python-version` = `3.12`).

## Схема работы

Агент получает A2A-запрос с Bearer user-JWT; `AgentContext` (SDK):
1. `auth.verify` — проверка подписи/iss/aud/exp по JWKS (кэш ключей) и проверка обязательных claim: набор задаётся опцией `requiredClaims` (TS) / `required_claims` (Python), дефолт — `['sub','org_id','billing_org_id']`. Claim обязаны присутствовать непустой строкой, иначе `AuthError` с кодом `missing_claim`. В `MultiIssuerJwtVerifier` то же поле применяется ко всем issuer'ам. Верификатор мемоизируется в `AgentContext.fromRequest`.
2. billing preflight (`assertExecutionAllowed`) — entitlement (любое значение `!= 'active'` → отказ; `payment_failed` → `PAYMENT_FAILED` проверяется первым, `no_resources` → `NO_TOKENS`), остаток токенов, `llmKey`. Пользовательский текст отказа — из единой карты `BILLING_USER_MESSAGES` / `billing_user_message`. Preflight берёт state по `billing_org_id` (`GET .../customers/by-billing-org/{id}/state`); отдельно клиент умеет state по организации — `getRuntimeStateByOrgId` / `get_runtime_state_by_org_id` (`GET .../customers/by-org/{orgId}/state`) для сервисов, у которых есть только `org_id`. Один кэш на оба маршрута, ключ `<маршрут>:<id>`, поэтому значения не подменяют друг друга при совпадении id.
3. LLM-вызов с `apiKey = llmKey`.
4. доменная работа.
5. `reportUsage` после успеха.

Вход в хост закрыт guard'ами: `jwtGuard` на A2A (`/a2a/v1`) и AG-UI (`/agui`), `mcpChallengeGuard` на `/mcp` (в python-хосте — `AuthGuardMiddleware` и `McpChallengeGuardMiddleware`). Они fail-closed: при `required=true` `AuthError` → 401 (MCP — с `WWW-Authenticate: Bearer resource_metadata="…"` по RFC 9728); любой другой сбой проверки → 503 с телом без деталей (`{"error": "auth_unavailable"}` для A2A/AG-UI, JSON-RPC `-32603` без `WWW-Authenticate` для MCP), downstream не вызывается. Детали сбоя — в лог без секретов и в метрику `ai37_agent_auth_guard_errors_total{service}`; лейбл `service` выводится из `card.name` (`serviceLabel`). При `required=false` сбой проверки пропускает запрос без ctx (аноним). В TS `next()` вызывается вне `try`.

```mermaid
flowchart LR
  REQ[запрос] --> G{guard: required?}
  G -->|AuthError| U[401 unauthorized<br/>MCP: + WWW-Authenticate]
  G -->|другой сбой, required=true| E[503 auth_unavailable<br/>метрика ai37_agent_auth_guard_errors_total]
  G -->|required=false| A[аноним без ctx]
  G -->|verified ctx| D[downstream]
```

Нормализация входящего A2A-сообщения (`parse.ts` / `parse.py`) читает конверт `metadata.ai37`, включая манифест `context_files`: одна запись `ContextFile` описывается `ref`/`name`/`scope` (+`summary`, `isLarge`) и опциональными `mime` и `hasRaw` (`mime` / `has_raw` в Python). В Python-хосте `_read_trace_carrier` собирает W3C-контекст из плоских ключей `message.metadata`: `traceparent` (обязателен) плюс `tracestate` и `baggage`, как `readTraceCarrier` в ts-host; без `traceparent` carrier — `None`.

При вызове суб-агента модуль `a2a` форвардит тот же user-JWT (`buildA2AAuthHeaders` / `forwardAuthFetch`). В TS `forwardAuthFetch` ставит `A2A-Version` только если вызывающий его не задал, а `Authorization` перезаписывает всегда; в Python `build_a2a_auth_headers(..., protocol_version=None)` не добавляет `A2A-Version` вовсе. В этом же модуле `a2a` живёт routing/v1 — компактный семантический профиль (`domains`/`intents`/`excludes`) для реестра агентов; канонический набор intents включает `document_generation`. Для тестов без сети есть подпакет `testing`.

Второе расширение Agent Card — `showcase/v1` (`AI37_SHOWCASE_EXTENSION_URI`, `https://schemas.ai37.ru/a2a/extensions/showcase/v1`). Обязательные `title` (≤60) и `summary` (≤160), опциональные `computes` (≤240), `norms` (≤4), `starter` (≤160), `examples` (≤4), `order` и `capabilities` (≤6 режимов). Запись `capabilities` (`AgentShowcaseCapability`) — режим-плитка: `id` (slug `^[a-z0-9][a-z0-9-]{0,39}$`, уникален в пределах агента), обязательные `title` и `summary`, опциональные `starter`, `examples` и `skill` (id скилла той же карточки, `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`); каталог показывает плитку только организациям, проходящим гейт этого скилла (`x-ai37.skills[skill].billing`) в дополнение к гейту агента. Нормализатор проверяет только форму ссылки (в Python `fullmatch`); обрезает длинный текст по кодовым точкам, отбрасывает битые элементы и дубликаты, парсер fail-open. Общий санитайзер строк карточки `compactText` / `compact_text` вынесен в `packages/ts/src/a2a/text.ts` / `packages/python/src/ai37_agent_sdk/a2a/text.py`. Схема — `contract/a2a-showcase-extension.schema.json`, векторы — `contract/a2a-showcase-extension.vectors.json`.

Отдельный модуль `policy` — общий разбор политики, объявленной переменной окружения: чтение произвольно названной переменной, сведение отсутствия/пустой строки/пробелов/нераспознанного значения к `fallback`, точное совпадение с объявленным набором состояний. Реализации паритетны: `packages/ts/src/policy/state.ts` и `packages/python/src/ai37_agent_sdk/policy/state.py`.

В host-слое `withTurnObservability` (TS) / `with_turn_observability` (Python) открывает turn-спан (Langfuse v5/OTel; env: `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`LANGFUSE_BASE_URL`; без ключей — полный no-op). По умолчанию содержимое хода не пишется: вместо `input.text` — `input.textLen`, вместо `output.message` — `status` и `messageLen`, а `payloadMode` помечается `redacted`, когда текст хода есть. При `LANGFUSE_CAPTURE_CONTENT=true` возвращается прежнее поведение. Второй линией обороны идёт маска клиента Langfuse — `langfuseContentMask` (TS, опция `mask` у `LangfuseSpanProcessor`) и `langfuse_content_mask` (Python, аргумент `Langfuse(mask=...)`): она применяется ко ВСЕМ наблюдениям перед экспортом, включая спаны `langfuse.langchain.CallbackHandler`; служебная метаданная хода (`trace.v1`) проходит как есть. Содержимое заменяется меткой `{"redacted": true, "chars": N}` (в TS — строкой JSON), `null`/`None` остаются собой.

В python-хосте (`ai37-agent-host` `0.1.0a26`) turn-спан открывается на обоих путях: AG-UI-роутер и `HostExecutor` (A2A) — спан `{service}:a2a` с `session_id=contextId` и `user_id=claims.sub`. Колбэки для `invoke` когниция берёт из `current_langfuse_callbacks()`; без инициализированного клиента список пуст и ход идёт как обычно. Кросс-сервисный контекст: входящий `traceparent` (плюс `tracestate`/`baggage`) даёт remote-родителя; если его нет — детерминированный `trace_context` из `metadata.ai37.trace_id`; если нет и его — ход становится корнем своего трейса (`trace.set_span_in_context(trace.INVALID_SPAN)`), чтобы не наследовать неэкспортируемый SERVER-спан `a2a-sdk`. `flush` после хода выполняется в фоновом потоке-демоне (`ai37-langfuse-flush`): ход его не ждёт, одновременно идёт не больше одного flush, ошибка пишется в лог и ход не роняет; остаток батча досылает `BatchSpanProcessor` и клиент при выходе процесса. В `propagate_attributes` уходят только заданные поля (ключи со значением `None` не передаются), контекст закрывается с концом хода.

Метрики host-слоя (`GET /metrics`) — низкокардинальные серии `ai37_*`, скрейпится внутрикластерным Alloy'ем. Хост реэкспортирует свой реестр и хелпер лейбла: `hostMetricsRegistry` + `serviceLabel` (TS) и `host_metrics_registry` + `service_label` (Python). Сбои проверки в guard'ах учитываются серией `ai37_agent_auth_guard_errors_total{service}` (503), отказы токена — `ai37_agent_auth_failures_total{service}` (401).

Логи агентов SDK очищает от секретов: `redactForLog` / `redact_for_log` обходит значение, заменяет строковые значения «секретных» полей на `[REDACTED]` на любой глубине и вырезает JWT / `Bearer …` / `sk-…` из всех строк; циклы → `[Circular]`, глубже 10 уровней → `[MaxDepth]`, ошибки копируются с тем же классом. В TS `agentLoggerOptions` встраивается в pino (`formatters.log`, `hooks.logMethod`); в Python `SecretRedactingFilter` ставится на handler и маскирует `record.msg`, `record.args` и поля `extra`. `AgentContext` при сериализации отдаёт `AgentContextLogView` — без JWT, ключа LLM и email.

### A2A на SDK 1.x в TS-хосте (0.2.x–0.4.0)

Сервер A2A TS-хоста стоит на `@a2a-js/sdk` 1.x (`DefaultRequestHandler` 1.x, события исполнения через `AgentEvent.task/statusUpdate/artifactUpdate`, части сообщения через `content.$case`, состояния — числовой `TaskState`). Контракт `AgentHandler` не изменился.

- **Compat 0.3 включён по умолчанию** (`legacyCompat` в `jsonRpcHandler`): запрос без заголовка `A2A-Version` или с `0.3` обрабатывается compat-слоем, с `1.0` — обработчиком 1.x. Выключается опцией `createAgentHost({ legacyCompat: false })`. Для стрима клиенту 0.3 ошибка протокола до первого события отдаётся событием SSE (middleware `legacyStreamErrorsAsSse`); сбой сервера (500) остаётся JSON с 500. Вместе с `legacyCompat` ставится `legacyBlockingDefault`: `message/send` клиента 0.3 с `configuration` без `blocking` получает `blocking: true` в сыром теле до compat.
- **Карточка.** Публичная гибридная отдаётся роутом `GET /.well-known/agent-card.json`: поля 0.3 верхнего уровня + `supportedInterfaces`, где JSON-RPC объявлен версиями `1.0` и `0.3` (`duplicateInterfacesForLegacy`). Обработчику SDK хост отдаёт карточку 1.x из `Ai37AgentCardInput` (`toSdkAgentCard`).
- **Владелец задачи** `<org_id>:<sub>` уходит в стор и через compat-трафик (`hostUserBuilder`, `currentCallContext()`).
- **Форма `input-required` — в `status.message`** data-частью `{ a2ui: [...] }`; `metadata.state` остаётся в `metadata`; копия в артефакте `a2ui-<taskId>` — только при `legacyCompat`.
- **Задача сливается, а не заменяется**: хост чистит форму прошлого шага, `answer-<taskId>` (пустым, если ход не стримил текст) и `metadata.state` (`null`).
- **Relay** на клиенте 1.x: `SendMessageRequest`, `StreamResponse` (`payload.$case`), `taskStateName`, `isTask`, `createAi37ClientFactory(fetchImpl?)`; `RemoteA2aResult.state` — строка 0.3, `raw` — `Message | Task` 1.x. `extractA2ui` читает форму в порядке `status.message` → артефакт `a2ui-<taskId>` → `metadata.a2ui`.

```mermaid
flowchart LR
  CARD[Ai37AgentCardInput: поля 0.3 + x-ai37] --> HI[hostInterfaces]
  HI --> DUP[duplicateInterfacesForLegacy: JSONRPC 1.0 + 0.3]
  DUP --> PUB[GET /.well-known/agent-card.json: поля 0.3 + supportedInterfaces]
  CARD --> SDK[toSdkAgentCard: карточка 1.x для DefaultRequestHandler]
  PUB -->|клиент 0.3, без A2A-Version| LEG[compat-слой SDK]
  PUB -->|клиент 1.x, A2A-Version: 1.0| NEW[обработчик 1.x]
```

```mermaid
flowchart LR
  R[Task input-required] --> SM[status.message: text + data {a2ui}]
  SM -->|канон, ts-host ≥ 0.2| X1[extractA2ui: место 1]
  R -->|legacyCompat, копия для relay 0.3| AR[артефакт a2ui-taskId]
  AR --> X2[extractA2ui: место 2]
  R -->|ts-host 0.1.x / python-host| MD[task.metadata.a2ui]
  MD --> X3[extractA2ui: место 3]
```

### Устойчивость хода, отмена и subpath `/dsh` (0.2.6–0.2.7)

- **`Ai37ChatCompletions` (0.2.6 / python `0.1.0a25`).** Один LLM-вызов сверху: дефолты `maxRetries: 1` и `timeout: 180_000`; 429 не повторяется; явно переданные `maxRetries`/`timeout`/`onFailedAttempt` побеждают. В python-хосте — `create_openai_client`/`resolve_llm_config` с 180 с на попытку и без повтора 429.
- **Heartbeat AG-UI.** `aguiRouter` раз в 15 с (`AGUI_HEARTBEAT_MS`; python `AGUI_HEARTBEAT_S = 15`) пишет в SSE комментарий `: ping`.
- **Keepalive A2A.** При 20 с тишины хост публикует `status-update` со `state: working` без сообщения и metadata (`A2A_KEEPALIVE_MS` / `A2A_KEEPALIVE_S = 20`).
- **Таймауты relay.** `RemoteA2aRequest.idleTimeoutMs`/`requestTimeoutMs` (python `idle_timeout_ms`/`request_timeout_ms`) — ошибка `TimeoutError`, без этих полей поведение прежнее.
- **Отмена хода.** `AgentRequest.signal` срабатывает при закрытии AG-UI-потока, A2A `tasks/cancel` и отмене MCP-вызова; `cancelTask` abort'ит ход и закрывает задачу `canceled` (в python `HostExecutor.cancel` публикует `canceled`), итог handler'а после отмены не публикуется; relay при отмене шлёт суб-агенту `tasks/cancel`. `McpToolDef.handler` получает третьим аргументом `signal`.
- **`@ai37/agent-host/dsh` (0.2.7).** `SingleHarnessRuntime`, `PerSessionScheduler`, `BoundedConcurrencyLimiter`, `childPlatformEnvironment`, `ScopedRequestBridge`, `scopedAsyncIterable`, `resumeStoredSession`/`closeHarnessSession`/`cancelHarnessSession`. Subpath не импортирует DSH, не запускает процесс при импорте, не хранит сессии; Python-хост этот адаптер не получает.

```mermaid
flowchart LR
  REQ[ход сессии] --> PSS[PerSessionScheduler: порядок по sessionId]
  PSS --> BCL[BoundedConcurrencyLimiter: общий лимит, FIFO]
  BCL --> SHR[SingleHarnessRuntime: ленивый общий harness]
  SHR --> BR[ScopedRequestBridge: nonce хода → /credential, /tool]
  SHR --> SAI[scopedAsyncIterable: ALS-контекст на каждом next]
```

### Файлы хода без виртуальной ФС (0.3.0–0.3.1 / python `0.1.0a27`)

Список файлов, которые агент может прочитать в текущем ходе, собирается детерминированно — LLM в выборе путей не участвует.

- **Скоуп.** `attachmentScope({ contextId, contextRefs, contextFiles })` (TS) / `attachment_scope(context_id, context_refs, context_files)` (Python) объединяет ссылки из `context_refs` и манифеста `context_files` без дублей по `ref`; в список попадают только `chat-attachment:<id>` (путь `/chat-attachments/<id>`) и `project-attachment:<id>` (`/project-attachments/<id>`), а `project:<id>` даёт `projectId` и файлом не считается. Без манифеста имя файла равно его `ref`. Хелперы: `hasFileRefs` / `has_file_refs` (есть ли в refs файловые/проектные ссылки) и `projectIdFromRefs` / `project_id_from_refs`.
- **Читатели (только TS).** `createAttachmentReaders({ chatBackendUrl, scope, bearer?, fetchImpl? })` — `read(ref, { offset, limit })` окнами по ref, `grep(query)` по обеим полкам (совпадения фильтруются по списку файлов хода), `readWithinBudget(ref, budgetChars)` (окна по 200 строк, не больше 1000 окон, стоп по бюджету символов, флаг `truncated`) и `file(ref)`. Ссылку, которой нет в скоупе, читатель отклоняет, не ходя в сеть. Под капотом — `Chat/ProjectAttachmentsStoreBackend`, то есть REST chat-backend с user-JWT (права проверяет он); `bearer` по умолчанию `currentBearer` из request-scope хоста, для кода вне него (мост DSH, фоновая задача) токен передаётся явно. Рядом `readStoreWithinBudget(backend, path, budgetChars)` — то же чтение окнами, но по готовому `StoreBackend` и пути, без скоупа хода.
- **Тексты в бюджет.** `readAttachmentContents(readers, { budgetChars })` читает все файлы хода в общий бюджет символов (по умолчанию без потолка), пустые файлы пропускает, а отказы возвращает с причиной `attachmentFailureReason(read.error)`: `access_denied` (401/403), `unavailable` (404/410), `reader_failed` (прочее), плюс `detail` — текст ошибки бэкенда (`fileId` и HTTP-статус, без имени файла).
- **Извлечение (только TS).** `extractFromAttachments({ llmKey, baseUrl, model, modelKwargs?, maxTokens?, systemPrompt, query, contents, timeoutMs? })` — один вызов `Ai37ChatCompletions` (`temperature: 0`, `callbacks: currentLangfuseCallbacks()`, таймаут по умолчанию 300 с); потолок ответа задаётся `maxTokens`, а не `modelKwargs.max_tokens` (LangChain перезаписывает поле). Без файлов, пустой ответ и ответ «нет данных» дают `null`; ошибки вызова не глотаются. `extractionRequest(query, contents)` собирает блоки `<файл имя="…" обрезан="да">`, `messageText(message)` берёт текст из строки/частей `content` и с запасным `reasoning_content`.

```mermaid
flowchart LR
  REFS[context_refs + context_files] --> SCOPE[attachmentScope: files + projectId]
  SCOPE --> RD[createAttachmentReaders: read / grep / readWithinBudget]
  RD --> CT[readAttachmentContents: общий бюджет символов]
  CT --> EX[extractFromAttachments: один LLM-вызов]
```

### Артефакты хода и база проекта (0.4.0)

Два независимых куска одного среза: чтение артефактов наравне с файлами хода и «долговременная база проекта» — пул проекта document-service, служебный токен и мост chat-backend.

**Артефакты хода.** `artifactScope({ chatBackendUrl, contextId, projectId?, bearer?, fetchImpl? })` один раз загружает корпус артефактов: сначала треда (`ArtifactsStoreBackend` со `scope: { contextId }`, ref `artifact:<id>`), затем — если задан `projectId` — проекта (`scope: { projectId }`, ref `project-artifact:<id>`). У каждого файла `kind: 'artifact'`, `scope` — полка, на которой он лежит; `summary`/`isLarge` берутся из манифеста. Список, который не загрузился, не роняет ход: его ошибка (`chat-backend /api/artifacts → HTTP 403`) попадает в `errors`, полка остаётся пустой, остальные файлы работают.

`createAttachmentReaders({ chatBackendUrl, scope, artifacts, bearer?, fetchImpl? })` добавляет файлы артефактов к файлам хода (ref, уже приложенный к ходу, второй раз не добавляется) и заводит две дополнительные полки — `ArtifactsStoreBackend` по треду и по проекту. Дальше всё как с вложениями: `read`/`readWithinBudget` читают только ref из загруженного списка (чужой не читается и в сеть не уходит), `grep` идёт по FTS chat-backend по каждому корпусу, а совпадения фильтруются по списку файлов; у артефактов и файлов проекта `line` всегда 1 (FTS не отдаёт номер строки, окно читается с начала). `readAttachmentContents` работает с артефактами наравне с вложениями. Без `artifacts` читатели ведут себя как в 0.3.1.

```mermaid
flowchart LR
  AS[artifactScope: artifact: + project-artifact:] --> RD[createAttachmentReaders({ scope, artifacts })]
  RD --> R1[read / grep / readWithinBudget]
  R1 --> CT[readAttachmentContents]
  CT --> EX[extractFromAttachments]
```

**Пул проекта DS.** `uploadToProjectPool({ documentServiceUrl, projectKey, file, fileName, projectName?, bearer, contentType?, fetchImpl?, timeoutMs? })` шлёт файл на `POST /api/project-pools/{projectKey}/documents` телом без multipart: имя в `X-File-Name` (`encodeURIComponent`), название пула — в `X-Project-Name`, размер — в `Content-Length` (DS без него тело не читает), `Content-Type` — `application/pdf` для `.pdf`, иначе `application/octet-stream` (остальные форматы DS проверяет по содержимому). `file` — `Uint8Array`/`Buffer`, `Blob` или `{ stream, size }`; поток уходит полудуплексом (`duplex: 'half'`). 201 → `{ seriesId }`; 409 `duplicate` → `{ duplicateOf: { id, title } }` (повтор того же содержимого не ошибка); прочее → `ProjectPoolError` с `code` из тела DS (`pool_not_found`, `ambiguous_project_pool`, `documents_not_in_plan`, `DOCUMENT_LIMIT_REACHED`, …), `status` и `retryAfterSeconds` у `upload_busy` (из `Retry-After`, иначе из тела). В текст ошибки попадают только код и статус — ни текст ответа, ни имя файла. `findProjectDocumentByTitle({ documentServiceUrl, projectKey, title, bearer, fetchImpl?, timeoutMs? })` ищет документ пула по названию целиком: DS ищет подстрокой без учёта регистра, поэтому SDK сверяет `title` точно и листает страницы (`take=50`, до 20 страниц по `nextCursor`); нет совпадения или пула — `null`.

**Служебный токен.** `serviceToken({ issuer, clientId, clientSecret, scope?, fetchImpl?, timeoutMs? })` — `client_credentials` для фоновых задач без пользователя (отчёт по расписанию грузится в пул от имени клиента Authentik; права задаёт политика DS). `token_endpoint` берётся из `<issuer>/.well-known/openid-configuration` и запоминается на процесс; токен кешируется в памяти до истечения с запасом (минута, у короткоживущих — половина срока; без `expires_in` — 5 минут), параллельные вызовы ждут один запрос, ключ кеша содержит sha256 секрета. Ошибки — `ServiceTokenError` (`discovery_failed`, `token_rejected`, `invalid_response`, `network_error`); секрет и тело ответа в текст не попадают.

**Мост chat-backend.** `indexToProject({ chatBackendUrl, projectId, refs, bearer?, fetchImpl?, timeoutMs? })` делает `POST /api/project-knowledge` с user-JWT (по умолчанию `currentBearer`) и возвращает `{ projectId, results }` — по результату на каждый ref в его порядке: `sent` (с `seriesId`), `already_indexed`, `not_indexable` (с `reason`: `raw_not_stored`, `format_not_accepted`, …), `busy` (с `retryAfterSeconds`) или `rejected` с кодом (`access_grant`, `project_private`, `role_forbidden`, `project_not_found`, `ref_not_found`, `invalid_ref`, `attach_failed`, `documents_not_in_plan`, `upstream_error`, …). Отказ запроса целиком — `ProjectKnowledgeError` (`no_scope`, `invalid_input`, `unauthorized`, `not_found`, `upstream_error`, `network_error`) в стиле `ArtifactPublishError`: в тексте только код, статус и короткий серверный код. Типы запроса/ответа (`ProjectKnowledgeRequest`, `ProjectKnowledgeResponse`, `ProjectKnowledgeRefResult`) — контракт для маршрута среза 3, проверки доступа, приватности и роли делает chat-backend.

```mermaid
flowchart LR
  TOK[serviceToken: client_credentials] --> UP[uploadToProjectPool]
  UP -->|POST /api/project-pools/{key}/documents| DS[(пул проекта document-service)]
  BR[indexToProject] -->|POST /api/project-knowledge| CB[chat-backend]
  CB --> DS
  FIND[findProjectDocumentByTitle] -->|GET /api/project-pools/{key}/documents?search=| DS
```

### Хост-слой: скиллы, чекпоинтер, MCP, владелец, Postgres

В host-слое агент строится из скиллов (`@ai37/agent-host/skills`): `SkillProvider` (`id`, `card`, `io`, `routing`, `billing`, `matches`, `handler`), реестр `createSkillRegistry` / `buildSkillRegistryFromEnv` (fail-closed, дефолтный скилл активен всегда), корневой `createSkillDispatchHandler` выбирает скилл по `metadata.ai37.intent.skill` → владельцу многоходовки из `taskState` (`__ai37_skill`) → первому матчеру → дефолтному; у скилла с `billing` диспетчер до handler-а делает `ctx.assertExecutionAllowed(skill.billing)`. `composeCardWithSkills(base, providers)` собирает Agent Card. Env `AGENT_SKILL_MODULES` подключает доменные модули инстанса.

Durable графовое состояние: `AgentHostOptions.checkpointer` (`BaseCheckpointSaver`) хост кладёт в turn-scope через `jwtGuard`, когниция берёт его через `currentCheckpointer()`; фабрика `createCheckpointer({ databaseUrl })` — `PostgresSaver.fromConnString` + идемпотентный `setup()` либо `MemorySaver`. Пакеты `@langchain/langgraph-checkpoint*` — optional peers, ленивый импорт.

MCP-экспорт: опция `mcp: { tools, scopes?, serverName? }` монтирует `/mcp` + OAuth-discovery (`.well-known/oauth-protected-resource`, RFC 9728) за verified auth. Контракт инструмента: `title` (обязателен) и опциональные `annotations`. Мост `bridgeHandlerToMcpTool` оборачивает когницию A2A-агента в MCP-tool со схемой `{query}`. `/mcp` закрыт `mcpChallengeGuard`.

```mermaid
flowchart LR
  MC[MCP-клиент] -->|POST /mcp| H[buildMcpServer]
  H -->|tools/list| T[McpToolDef: name + title + annotations]
  H -->|tools/call| BR[bridgeHandlerToMcpTool → handler.run]
```

Владелец A2A-задачи в python-хосте берётся из проверенного JWT хода и одинаков на A2A- и AG-UI-пути (`owner.py`). Сторы `a2a-sdk` 1.x (`InMemoryTaskStore`, `DatabaseTaskStore`) и `RedisTaskStore` разводят задачи по `owner_resolver(context)`. `HostCallContextBuilder` собирает пользователя из `AgentContext.claims` хода (`JwtUser`, `user_name = <org_id>:<sub>`); без JWT — анонимный пользователь. У `RedisTaskStore` владелец входит в ключ (`{prefix}{owner}:{task_id}`).

Durable A2A task store python-хоста — `PostgresTaskStore` (extra `postgres`): обёртка над upstream `a2a.server.tasks.DatabaseTaskStore`, owner-scoped `get`/`list`/`delete`, неизменяемость завершённой задачи, `assert_ready()`, ретенция `cleanup(...)`, схема создаётся шагом деплоя (`create_table=False`). Таблица по умолчанию — `a2a_tasks`; `id`/`context_id` — `varchar(255)`.

Durable A2A task store TS-хоста — `Ai37TaskStore` (subpath `@ai37/agent-host/task-store`) поверх `DatabaseTaskStore` (`public.a2a_tasks`): владелец из контекста вызова, ключ строки `(tenant, owner, id)`, неизменяемость завершённой задачи, `id`/`contextId` до 255, гигиена `history`/`metadata`, `assertReady()`, `cleanup()`, `fromDatabaseUrl()`, `close()`. CLI `ai37-agent-host-task-store migrate|check|cleanup` (строка подключения — только из `DATABASE_URL`). Опция `externalSchema` и переменная `TASK_STORE_EXTERNAL_SCHEMA=true` переводят стор в режим, где схему ведёт сам сервис (например, Prisma в chat-backend): `check`/`cleanup`/`assertReady` проверяют таблицу, колонки и ширину `id`/`context_id` без журнала `a2a_a2a_tasks_migrations`, а `migrate` отказывается (exit 1). `createTaskStoreFromEnv()`: `DATABASE_URL` → `Ai37TaskStore`, без него в production — ошибка, в dev/тестах — `InMemoryTaskStore`. `createPostgresKysely`/`createPostgresPool` создают пул с обязательным слушателем `error`.

```mermaid
flowchart LR
  ENV[DATABASE_URL] --> CTS[createTaskStoreFromEnv]
  CTS --> ATS[Ai37TaskStore: DatabaseTaskStore + owner/immutability/hygiene]
  ATS --> PG2[(public.a2a_tasks, журнал a2a_a2a_tasks_migrations)]
  CLI[ai37-agent-host-task-store migrate|check|cleanup] --> PG2
```

Persist-state многоходового A2A-диалога в python-хосте читается из data-part артефактов задачи: `_read_prior_state` перебирает артефакты С КОНЦА и отдаёт ПОСЛЕДНЕЕ записанное состояние, с фолбэком на `task.metadata.state`; `input-required` и `working` публикуются БЕЗ закреплённого `artifact_id`, единственный закреплённый id — `result` у `completed`.

Стриминг прогресса A2A-пути вынесен в `A2aProgress` (`packages/ts-host/src/a2a-progress.ts`, `packages/python-host/src/ai37_agent_host/a2a_progress.py`): `node`/`reasoning` — `status-update` с metadata `ai37/node`/`ai37/reasoning`, `text` — нативные `artifact-update` append-дельты одного стабильного артефакта (`answer-{taskId}`, `name: answer`). Терминальный Task сохраняет полный канонический ответ в `status.message`.

### Доменный контракт захвата

`ai37-capture-contract` описывает обмен между агентом мониторинга цен и рендерерами: browser-worker minstroy снимает пачку карточек одного магазина в общей сессии (`CaptureBatchRequest` → `CaptureBatchResponse`) и кладёт снимки в бакет (`storage_key` + `sha256`); рендерер вне кластера отдаёт PNG в теле ответа (`RemoteCaptureBatchResponse`, `png_base64`). Причина отказа едет строкой `reason_code` из набора `REASON_*`. Порядок ответов — по одному результату на каждый элемент запроса. `GET /health` рендерера читается кодом `RendererHealth`. `PRICE_HINTS_JS` — строка для `page.evaluate`.

## Структура каталогов

- `contract/` — общий контракт SDK: JSON Schema runtime state, routing/v1 (`a2a-routing-extension.schema.json`), showcase/v1 (`a2a-showcase-extension.schema.json` + векторы `a2a-showcase-extension.vectors.json`), коды фич и привилегий (включая `pdai-audit-assist-allowed` и `polimetrika-data-agent`/`polimetrika-data-agent-allowed`), `env.md`.
- `packages/ts/` — TypeScript-реализация SDK (`@ai37/agent-sdk`, `0.1.0-alpha.36`): `src/auth/verifier.ts`, `src/auth/verifierCache.ts`, `src/a2a/forward.ts`, `src/a2a/routing.ts`, `src/a2a/showcase.ts`, `src/a2a/text.ts`, `src/context.ts`, `src/billing/client.ts`, `src/log-redaction.ts`, `src/policy/state.ts`, `src/codes.ts` (генерируется); тесты `test/a2a.test.ts`, `test/verifierCache.test.ts`, `test/auth.test.ts`, `test/billing.test.ts`, `test/policy.test.ts`, `test/showcase.test.ts`, `test/log-redaction.test.ts`, `test/context-log-view.test.ts`, `test/codes.test.ts`.
- `packages/python/` — Python-реализация SDK (`ai37-agent-sdk`, `0.1.0a28`): `src/ai37_agent_sdk/auth/verifier.py`, `src/ai37_agent_sdk/a2a/forward.py`, `src/ai37_agent_sdk/a2a/showcase.py`, `src/ai37_agent_sdk/a2a/text.py`, `src/ai37_agent_sdk/billing/client.py`, `src/ai37_agent_sdk/context.py`, `src/ai37_agent_sdk/log_redaction.py`, `src/ai37_agent_sdk/policy/state.py`, `src/ai37_agent_sdk/codes.py` (генерируется); тесты `tests/test_a2a.py`, `tests/test_verifier_cache.py`, `tests/test_auth.py`, `tests/test_billing.py`, `tests/test_policy.py`, `tests/test_showcase.py`, `tests/test_context.py`, `tests/test_log_redaction.py`, `tests/test_codes.py`.
- `packages/ts-host/` — TS host (`@ai37/agent-host`, `0.4.0`): A2A-сервер на `@a2a-js/sdk` 1.x с `legacyCompat`, AG-UI, MCP, task store (InMemory и durable Postgres), observability/Langfuse, скиллы, обвязка DSH, файлы хода, артефакты и база проекта. Ключевые файлы: `src/createAgentHost.ts`, `src/auth-guard.ts`, `src/metrics.ts`, `src/request-handler.ts`, `src/legacy-stream-errors.ts`, `src/agent-card.ts`, `src/a2a-executor.ts`, `src/a2a-progress.ts`, `src/build-task.ts`, `src/parts.ts`, `src/parse.ts`, `src/owner.ts`, `src/als.ts`, `src/terminal-states.ts`, `src/task-state.ts`, `src/ai37-chat-completions.ts`, `src/observability/langfuse.ts`, `src/attachments/{turn-files,readers,contents,extract,artifact-scope,index}.ts`, `src/project-knowledge/{project-pool,service-token,index-to-project,index}.ts`, `src/relay/`, `src/task-store/`, `src/cli/`, `src/skills/`, `src/mcp/`, `src/dsh/`, `src/store-backend/` (включая `artifacts-store-backend.ts` с публичным `list()` и экспортируемыми `ArtifactMetaDto`/`ArtifactFileDto`); тесты `test/agent-card.test.ts`, `test/host.test.ts`, `test/auth-guard.test.ts`, `test/legacy-request.test.ts`, `test/langfuse-content.test.ts`, `test/skills.test.ts`, `test/checkpointer.test.ts`, `test/mcp.test.ts`, `test/metrics-export.test.ts`, `test/a2a-text-stream.test.ts`, `test/final-task-events.test.ts`, `test/relay.test.ts`, `test/compat-mixed-fleet.test.ts`, `test/task-store.unit.test.ts`, `test/task-store.pg.test.ts`, `test/attachments-helpers.test.ts`, `test/attachments-artifacts.test.ts`, `test/project-knowledge.test.ts`, `test/dsh-*.test.ts`; проверка пакета — `scripts/check-dsh-package.mjs`.
- `packages/python-host/` — python host (`ai37-agent-host`, `0.1.0a27`): `create_agent_host`, AG-UI, MCP, Redis/Postgres task store, `owner.py`, `a2a_executor.py` (turn-спан `with_turn_observability` на A2A-ходе), `postgres_task_store.py`, `relay/execute.py`, `metrics.py`, `a2a_progress.py`, `parse.py` (`trace_carrier` с `traceparent`/`tracestate`/`baggage`), `observability/langfuse.py` (`with_turn_observability`, `_remote_parent_context`, `_root_context`, `_flush_in_background`, `_apply_trace_attributes`, `is_langfuse_content_captured`, `langfuse_content_mask`, `_redacted_marker`), `auth_guard.py`, `mcp/challenge_guard.py`, `mcp/mount.py`, `store_backend/` (включая `turn_files.py` — `attachment_scope`, `has_file_refs`, `project_id_from_refs`, `AttachmentFile`, `AttachmentTurnScope`); тесты `tests/test_auth_guard.py`, `tests/test_langfuse_mask.py`, `tests/test_langfuse_turn.py`, `tests/test_langfuse_noop.py`, `tests/test_parse.py` (в т.ч. `tracestate`/`baggage`), `tests/test_metrics_export.py`, `tests/test_checkpointer.py`, `tests/test_executor_streaming.py`, `tests/test_executor_text_stream.py`, `tests/test_prior_state.py`, `tests/test_mcp_server.py`, `tests/test_mcp_bridge.py`, `tests/test_relay_execute.py`, `tests/test_owner.py`, `tests/test_postgres_task_store.py`, `tests/test_turn_files.py`.
- `packages/ts-docx/` — TS-пакет `@ai37/docx` (детерминированный markdown→DOCX-рендерер; проверяется в CI: lint + test + build).
- `packages/capture-contract/` — доменный Python-пакет `ai37-capture-contract` (`0.1.0`, Python ≥ 3.12, `pydantic>=2`): `models.py`, `remote.py`, `health.py`, `price_hints.py`, `py.typed`, тесты `tests/test_capture_contract.py`.
- Чейнджлоги — по пакетам: `packages/ts/CHANGELOG.md`, `packages/ts-host/CHANGELOG.md`, `packages/python/CHANGELOG.md`, `packages/python-host/CHANGELOG.md`, `packages/capture-contract/CHANGELOG.md`; ссылки собраны в корневом `CHANGELOG.md`.
- `.github/workflows/` — CI (`ci.yml`, одна джоба `ci-green`: шаги пакетов `ts-docx`, `ts` (+ build dist для хоста), `ts-host` (общий сервис `postgres:18-alpine`, `format:dsh:check`, `test:package`; env `TEST_DATABASE_URL` и `REQUIRE_TEST_DATABASE=1`), `python`, `python-host`, `capture-contract`) и публикация (`publish-ts.yml`, `publish-python.yml`, `publish-ts-host.yml`, `publish-python-host.yml`, `publish-ts-docx.yml`, `publish-capture-contract.yml`). Poetry в Python-джобах CI и публикации ставится официальным установщиком: `curl -fsSL https://install.python-poetry.org | python3 -` с `POETRY_VERSION=2.3.2` и `POETRY_HOME=${{ runner.temp }}/poetry`; `twine` — `python -m pip install twine`. Раннер выбирается инпутом `runner` (`auto`/`ubuntu-latest`/`ai37-self-hosted`) и переменными `CI_RUNNER`/`CD_RUNNER`; фолбэк — `ubuntu-24.04` (в `publish-capture-contract.yml` и `publish-python-host.yml` — `ubuntu-latest`). В publish-js dist-tag вычисляется из версии пакета.
- `docs/` — внутренние документы репозитория, включая `migrate-to-private-registry-plan.md` и `docs/plans/` (в т.ч. `search-agent-chat-attachments.md`, `project-knowledge-bridge.md`).

## Публичные интерфейсы

- **SDK (npm/PyPI):** модули `auth`, `billing`, `a2a`, `context` (`AgentContext`), `codes`, `policy`, `log-redaction`, `testing`. В `billing` — `BILLING_USER_MESSAGES`, `DEFAULT_BILLING_USER_MESSAGE`, `billingUserMessage`/`billing_user_message`, `friendlyBillingMessage`, `explainDenial`, `BillingDenialReason` (включая `PAYMENT_FAILED`), а также два способа адресации runtime state: `getRuntimeStateByBillingOrgId` / `get_runtime_state_by_billing_org_id` (маршрут `by-billing-org`, id из JWT) и `getRuntimeStateByOrgId` / `get_runtime_state_by_org_id` (маршрут `by-org`, для сервисов, у которых есть только `org_id`); оба входят в `BillingClient` (TS) / Protocol `BillingClient` (Python) и реализованы в `InMemoryBillingClient`, кэш общий, ключи разведены по маршруту, ошибки — `BillingRequestError` с `orgId=<id>` / `billingOrgId=<id>` в тексте. В `a2a` — routing/v1 и showcase/v1 (`AI37_SHOWCASE_EXTENSION_URI`, тип `AgentShowcaseCapability` с опциональным `skill`, `buildAgentShowcaseExtension`, `normalizeAgentShowcaseProfile`, `parseAgentShowcaseExtension` и Python-зеркала). В `auth` — `JwtVerifierOptions.requiredClaims` / `required_claims`. В `a2a.forward` — `forwardAuthFetch` не перезаписывает заданный клиентом `A2A-Version`; Python `build_a2a_auth_headers(..., protocol_version=None)`. В `policy` — `parsePolicyState`/`readPolicyState` (TS) и `parse_policy_state`/`read_policy_state` (Python). В `codes` — `BillingFeatureCode`/`BillingPrivilegeCode` (включая `PdaiAuditAssistAllowed`, `PolimetrikaDataAgent`, `PolimetrikaDataAgentAllowed`). В `log-redaction` — `REDACTED`, `SECRET_KEY_PATTERN`, `redactSecretsInText(text)`, `redactForLog(value)`, `agentLoggerOptions({ level, name })`, `AgentLoggerOptions` (TS); паритет в Python — `redact_secrets_in_text`, `redact_for_log`, `SecretRedactingFilter`. `AgentContext.toJSON()`/`util.inspect` (TS) и `log_view()`/`__repr__` (Python) отдают `AgentContextLogView` без JWT, ключа LLM и email.
- **CLI (TS SDK):** dev-утилиты (`devJwks`, `devBilling`, `devKey`). Python-пакет без CLI.
- **Host-слой `@ai37/agent-host` (TS, `0.4.0`):** `createAgentHost(opts)` собирает Express-приложение. HTTP: `/.well-known/agent-card.json` (гибридная карточка), `/a2a/v1` (A2A JSON-RPC 1.0 и 0.3 через `legacyCompat`), `/agui` (AG-UI SSE с heartbeat), `/api/v1/health`, `/api/v1/version`, `/metrics`, `/mcp` (опция `mcp`). Опции: `card`, `handler`, `agentContext`, `catalogId`, `taskStore`, `checkpointer`, `legacyCompat` (default `true`), `mcp`. Guard'ы: `jwtGuard(...)`, `mcpChallengeGuard(...)`. Subpaths: `./relay` (`executeRemoteA2a`, `executeRemoteA2aStreaming`, `createAi37ClientFactory`, `isStaleTaskError`, `taskStateName`, `isTask`, `extractText`, `extractA2ui`), `./skills`, `./task-store` (`Ai37TaskStore`, `assertTaskStoreReady`, `createTaskStoreFromEnv`, `createPostgresKysely`, `createPostgresPool`, `externalSchemaFromEnv`, `migrateTaskStore`, `checkTaskStoreSchema`, `TaskStoreSchemaError`, `MAX_ID_LENGTH`, `TASK_TABLE_NAME`, `ledgerTableFor`), `./dsh`. В корневом API также `Ai37ChatCompletions` (дефолты `maxRetries: 1`, `timeout: 180_000`).
- **Файлы хода и артефакты в корневом API `@ai37/agent-host` `0.4.0`:** `attachmentScope`, `hasFileRefs`, `projectIdFromRefs`, `createAttachmentReaders`, `attachmentFailureReason`, `readStoreWithinBudget`, `readAttachmentContents`, `extractFromAttachments`, `extractionRequest`, `messageText`, `artifactScope`; типы `AttachmentFile` (с `kind?: 'artifact'`), `AttachmentTurnInput`, `AttachmentTurnScope`, `AttachmentReaders`, `AttachmentReadersOptions` (с `artifacts?: ArtifactScope`), `AttachmentGrepHit`, `WindowedRead`, `AttachmentContent`, `AttachmentContentsResult`, `AttachmentReadFailure`, `ReadAttachmentContentsOptions`, `ExtractFromAttachmentsOptions`, `ArtifactScope`, `ArtifactScopeOptions`. `grep` отдаёт только совпадения по файлам хода и артефактам из загруженных списков (у артефактов и файлов проекта `line` = 1); `readWithinBudget` — окна по 200 строк (до 1000 окон) и стоп по бюджету символов; `attachmentFailureReason` — `access_denied` (401/403) / `unavailable` (404/410) / `reader_failed`. Из корня также экспортируются `ArtifactMetaDto` и `ArtifactFileDto`; `ArtifactsStoreBackend.list()` отдаёт манифест корпуса с метаданными.
- **База проекта в корневом API `@ai37/agent-host` `0.4.0` (`src/project-knowledge/`):** `uploadToProjectPool`, `findProjectDocumentByTitle`, `serviceToken`, `indexToProject`, классы `ProjectPoolError`, `ServiceTokenError`, `ProjectKnowledgeError`; типы `UploadToProjectPoolOptions`, `ProjectPoolFile`, `ProjectPoolUploadResult`, `ProjectPoolDuplicate`, `ProjectPoolErrorCode`, `ProjectPoolDocument`, `ProjectPoolDocumentState`, `FindProjectDocumentByTitleOptions`, `ServiceTokenOptions`, `ServiceTokenErrorCode`, `IndexToProjectOptions`, `ProjectKnowledgeRequest`, `ProjectKnowledgeResponse`, `ProjectKnowledgeRefResult`, `ProjectKnowledgeStatus`, `ProjectKnowledgeRejectCode`, `ProjectKnowledgeNotIndexableReason`, `ProjectKnowledgeErrorCode`. Env-переменных эти функции не читают: `documentServiceUrl`, `projectKey`, `chatBackendUrl`, `bearer`, `issuer`/`clientId`/`clientSecret` передаются параметрами (образцы в README пакета — `OIDC_ISSUER`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET`, `CHAT_BACKEND_URL` у потребителя).
- **Файлы хода в python-хосте (`ai37-agent-host` `0.1.0a27`):** `attachment_scope(context_id, context_refs, context_files)`, `has_file_refs`, `project_id_from_refs` и dataclass'ы `AttachmentFile` / `AttachmentTurnScope` в `ai37_agent_host.store_backend` (реэкспорт из корня пакета). Читатели, артефакты и извлечение не портированы; модуля «база проекта» в python-хосте нет.
- **CLI (TS-host):** bin `ai37-agent-host-task-store` (`migrate | check | cleanup`, только `DATABASE_URL`; `--table`, `cleanup` — `--terminal-days` (7), `--stale-days` (14) или `--keep-stale`, `--batch-size` (1000); коды выхода 0/1/2). При `TASK_STORE_EXTERNAL_SCHEMA=true` `migrate` отказывается с exit 1.
- **BREAKING (`@ai37/agent-host` `0.2.0`):** сервер на `@a2a-js/sdk` 1.x; гибридная карточка; форма `input-required` в `status.message`; `RemoteA2aResult.raw` — `Message | Task` 1.x; `toTask`/`agentMessage`/`toAguiSnapshot` возвращают типы 1.x; `saveTaskState` в завершённую задачу не пишет и возвращает `false`.
- **Отмена и таймауты relay (`0.2.6` / python `0.1.0a25`):** `AgentRequest.signal`, `cancelTask`, `RemoteA2aRequest.idleTimeoutMs`/`requestTimeoutMs`/`signal`, `McpToolDef.handler(args, extra, signal)`; в python — `idle_timeout_ms`/`request_timeout_ms` и `HostExecutor.cancel`.
- **Поведение guard'ов (`0.2.3` / `0.1.0a23`):** при `required=true` сбой проверки, не являющийся `AuthError`, → 503 без деталей и без вызова handler'а; при `required=false` — аноним.
- **Поведение compat 0.3 (`0.2.4`):** `legacyBlockingDefault` (блокирующий `message/send` 0.3 без `configuration.blocking`), `legacyStreamErrorsAsSse` (SSE только для ошибок протокола со статусом 200), очистка `answer-<taskId>` прошлого хода.
- **Маска содержимого Langfuse (`0.2.5` / `0.1.0a24`):** `langfuseContentMask({ data })` / `langfuse_content_mask(*, data)` — метка `{"redacted": true, "chars": N}` (в TS — строкой JSON), служебная метаданная `trace.v1` проходит как есть; `isLangfuseContentCaptured()` / `is_langfuse_content_captured()` по `LANGFUSE_CAPTURE_CONTENT` (default `false`).
- **Трассировка A2A-хода в python-хосте (`ai37-agent-host` `0.1.0a26`):** `with_turn_observability` вызывается хостом сам и на AG-UI, и на A2A (`HostExecutor`, спан `{service}:a2a`); агенту оборачивать ход не нужно — вложенный вызов откроет второй turn-спан корнем отдельного трейса. Колбэки — `current_langfuse_callbacks()`; `traceparent`/`tracestate`/`baggage` читаются из `message.metadata`, служебный `metadata.ai37.trace_id` — фолбэк. `flush` — фоновый поток-демон, не больше одного одновременно; ошибка flush логируется и ход не роняет. Устанавливается extra `observability` (`langfuse>=5.0,<6`); без пакета или ключей — полный no-op.
- **Маскировка секретов в логах SDK (`0.1.0-alpha.32` / `0.1.0a24`):** `redactForLog`/`redact_for_log`, `redactSecretsInText`/`redact_secrets_in_text`, `agentLoggerOptions`, `SecretRedactingFilter`; `AgentContext` при сериализации — выжимка без JWT, ключа LLM и email.
- **Поведение `showcase/v1` (`0.1.0-alpha.33` / `0.1.0a25`):** у возможности (`AgentShowcaseCapability`) необязательное `skill` (id скилла той же карточки, форма без чистки краёв; в Python `fullmatch`); пустой `norms` значит «агент на нормативы не ссылается». Общие векторы дополнены кейсами про `skill`.
- **Новые коды привилегий:** `PdaiAuditAssistAllowed` = `pdai-audit-assist-allowed` внутри `pdai-doc-152fz` (`0.1.0-alpha.34` / `0.1.0a26`); `BillingFeatureCode.PolimetrikaDataAgent` = `polimetrika-data-agent` и `BillingPrivilegeCode.PolimetrikaDataAgentAllowed` = `polimetrika-data-agent-allowed` (`0.1.0-alpha.35` / `0.1.0a27`). Регистрация кода права не выдаёт; паритет с `contract/feature-codes.json` проверяют `packages/ts/test/codes.test.ts` и `packages/python/tests/test_codes.py`.
- **State по организации в billing-клиенте (`0.1.0-alpha.36` / `0.1.0a28`):** `getRuntimeStateByOrgId(orgId)` / `get_runtime_state_by_org_id(org_id)` ходит на `GET /api/v1/billing/customers/by-org/{orgId}/state` тем же `authToken` (apps-token); id кодируется в пути (`encodeURIComponent` / `quote`); результат кэшируется на `runtimeStateCacheTtlMs` (дефолт 5000 мс, `0` — без кэша); ошибка — `BillingRequestError` (`Billing state request failed for orgId=<id>: HTTP <status>`), неудача не кэшируется. Требует, чтобы маршрут `by-org` был выкачен в billing.
- **MCP-контракт инструмента:** `McpToolDef` — `name`, обязательный `title`, `description`, опциональные `annotations`, `inputSchema`, `handler`; `BridgeToolOptions` (`bridgeHandlerToMcpTool` / `bridge_handler_to_mcp_tool`) — `name`, обязательный `title`, `description`, `annotations`, `inputSchema`/`input_schema`, `textModes`/`text_modes`, `renderResult`/`render_result`.
- **Python host (`ai37-agent-host` `0.1.0a27`):** `create_agent_host(..., task_store=..., checkpointer=...)`, `current_checkpointer()`, `host_metrics_registry`, `service_label`, `owner.py`, `PostgresTaskStore`, `create_engine`, `to_async_url`, `migrate_postgres_task_store`, CLI `python -m ai37_agent_host.postgres_task_store migrate|cleanup`. Observability (`ai37_agent_host.observability`): `with_turn_observability`, `with_remote_a2a_observability`, `inject_trace_context`, `is_langfuse_enabled`, `is_langfuse_content_captured`, `langfuse_content_mask`, `BeginTurnArgs`, `TRACE_SCHEMA_VERSION`, `trace_metadata`. Guard'ы: `AuthGuardMiddleware`, `McpChallengeGuardMiddleware(service=...)`, `MountMcpOptions.service`. Extra: `redis`, `postgres`, `observability`.
- **PyPI-пакет `ai37-capture-contract` (`0.1.0`):** `models` (`CaptureBatchRequest`/`CaptureBatchResponse`, `CaptureRequest`, `CaptureBatchItem`, `CaptureResponse`, `CaptureStatus`, `Screenshot`, `ScreenshotRole`, `CaptureEnvironment`, `ActionRecord`, `PriceHint`, `Clip`, `REASON_*`), `remote` (`RemoteScreenshot`, `RemoteCaptureResponse`, `RemoteCaptureBatchResponse`), `health` (`RendererHealth`, `RendererKind`, `RendererState`, `RendererCapacity`, `ExitHealth`), `price_hints` (`PRICE_HINTS_JS`). HTTP-эндпоинтов сам не поднимает.

## Зависимости в экосистеме

### Зависит от

- SDK `@ai37/agent-sdk` (peer-зависимость host-слоя, `>=0.1.0-alpha.11`), в python-host — `ai37-agent-sdk` (`>=0.1.0a1,<0.2.0`).
- `@a2a-js/sdk` `^1.3.0` — ts-host (сервер и клиент 1.x), dev-зависимость `a2a-sdk-v03` (`npm:@a2a-js/sdk@0.3.13`); python-host — `a2a-sdk >=1.1.0`.
- billing-сервиса (`BILLING_BASE_URL`): preflight, runtime state, usage. Runtime state берётся по `GET /api/v1/billing/customers/by-billing-org/{id}/state` (агенты, id из JWT) либо по `GET /api/v1/billing/customers/by-org/{orgId}/state` (сервисы, у которых есть только `org_id`); usage — `POST /api/v1/events`. Пустой `billing.appsAuthToken` / `apps_auth_token` — `BillingConfigurationError`, из-за которой guard fail-closed отвечает 503.
- JWKS/OIDC issuer (`JWKS_URL`, `ISSUER`, `AUDIENCE`).
- LLM-шлюза (LiteLLM) — через `llmKey` из runtime state; клиент — OpenAI-совместимый chat (`Ai37ChatCompletions`), в том числе для `extractFromAttachments`.
- chat-backend REST — источник файлов хода и артефактов: читатели ходят в полки `/api/chat-attachments`, `/api/project-attachments` и `/api/artifacts` с user-JWT хода, права проверяет chat-backend; мост `indexToProject` вызывает его `POST /api/project-knowledge`.
- document-service — пул проекта: `uploadToProjectPool` (`POST /api/project-pools/{projectKey}/documents`) и `findProjectDocumentByTitle` (`GET …/documents?search=`).
- Authentik (или другой OIDC-провайдер) — только для `serviceToken` (`client_credentials`): discovery issuer'а и `token_endpoint`. Обычный user-JWT SDK проверяет по JWKS.
- Суб-агентов по A2A (forward user-JWT и манифеста `context_files` с `mime`/`hasRaw`).
- Redis — только host-слой (optional extra `redis`).
- Postgres — durable-режим: LangGraph-чекпоинтер, `Ai37TaskStore` (optional peers `kysely` + `pg`), `PostgresTaskStore` (extra `postgres`).
- Langfuse — опционально, только host-слой: в Python — extra `observability` (`langfuse>=5.0,<6`, soft-import) и dev-зависимость для тестов; без пакета/ключей трассировка выключена.
- `prom-client` (TS) и `prometheus-client` (Python) — `GET /metrics`.
- `@langchain/langgraph-checkpoint` / `...-postgres` — optional peers host-слоя; `@langchain/openai` — optional peer для LLM-клиента.
- `@modelcontextprotocol/sdk` + `zod` (TS) и python `mcp` — только при MCP-экспорте; отсутствие `mcp` → `MissingMcpDependencyError`.
- `@ag-ui/core` + `@ag-ui/encoder` — AG-UI-транспорт ts-host.
- `pino` (`^9.14.0`) — только devDependency `packages/ts`.
- `pydantic>=2` — единственная runtime-зависимость `ai37-capture-contract`.
- Внешние зависимости ядра SDK: `jose` + `lru-cache` (TS), `pyjwt[crypto]` + `httpx` (Python).
- `@ai37/a2ui-catalog-schemas` `^0.10.0` — из приватного Verdaccio, нужен `NPM_CONFIG_USERCONFIG` в CI/публикации ts-host.
- `@langfuse/otel`, `@langfuse/tracing`, `@opentelemetry/api`, `@opentelemetry/sdk-node` — трассировка ts-host; `opentelemetry-sdk`/OTLP-экспортёр — транзитивно через `langfuse` в python-host.
- Upstream harness/DSH — только у потребителя subpath `@ai37/agent-host/dsh`.

### От него зависят

- Агенты AI37, использующие SDK/`AgentContext`, и host-пакеты `@ai37/agent-host` / `ai37-agent-host` поверх SDK.
- Сервисы, у которых есть только `org_id` (DS берёт его из записи пула проекта): получают state продукта через `getRuntimeStateByOrgId` / `get_runtime_state_by_org_id` — при условии, что в billing выкачен маршрут `by-org`.
- Агенты, которые держали свою копию `file-enricher.ts` (шаблон, search-agent, elevator, thermal, doc-gen): переезжают на `attachmentScope` / `createAttachmentReaders` / `readAttachmentContents` / `extractFromAttachments`; потребители скоупа в python-хосте — `attachment_scope`.
- Агенты, читающие свои артефакты: `artifactScope` + `createAttachmentReaders({ artifacts })` (ref `artifact:<id>` и `project-artifact:<id>`, `AttachmentFile.kind: 'artifact'`), в том числе через `readAttachmentContents`.
- Строители «базы проекта» (срез 2 плана `project-knowledge-bridge`): на `uploadToProjectPool`/`serviceToken` строятся мост chat-backend (срез 3), поиск (срез 4) и фоновые отчёты агента данных Полиметрики (срез 6).
- Потребители моста `indexToProject`: UI-пункт «добавить в базу проекта» и chat-backend, реализующий маршрут `POST /api/project-knowledge` по типам `ProjectKnowledgeRequest`/`ProjectKnowledgeResponse`/`ProjectKnowledgeRefResult`.
- Потребители `serviceToken` — фоновые задачи и CronJob'ы агентов без пользовательского JWT.
- Клиенты Agent Card: гибридная карточка TS-хоста читается клиентами 0.3 и 1.x; расширения `x-ai37` сохраняются для оркестратора.
- Потребители relay: `createAi37ClientFactory(fetchImpl)`, `RemoteA2aResult.state` (строки 0.3), `idleTimeoutMs`/`requestTimeoutMs`/`signal` для таймаутов и отмены.
- Потребители `extractA2ui` (relay/оркестратор): порядок `status.message` → артефакт `a2ui-<taskId>` → `metadata.a2ui`; места — копии, не складываются.
- Потребители `extractText`: текст из артефакта `answer-<taskId>` (дельты) и `status.message` терминального Task; пустой артефакт в финале значит «ход не стримил», а не «текст потерян».
- Клиенты 0.3, читающие копию формы в артефакте `a2ui-<taskId>` (живёт только при `legacyCompat`).
- Самописные клиенты A2A 0.3 с `message/send` и `configuration` без `blocking` — получают блокирующий ответ, как от сервера 0.3.
- Клиенты агента с `required=true`: при сбое конфигурации/зависимости auth-billing получают 503 `auth_unavailable` (A2A/AG-UI) или JSON-RPC `-32603` (MCP).
- Потребители метрик `ai37_agent_auth_failures_total{service}` (401) и `ai37_agent_auth_guard_errors_total{service}` (503) — алерты Tier-2.
- Сервис `document-service`; агент поиска документов; помощник аудита PD-AI (`pdai-audit-assist-allowed`); агент данных кабинета Полиметрики (`polimetrika-data-agent`/`polimetrika-data-agent-allowed`, право дают тарифы Lago).
- Агенты, публикующие showcase/v1, в том числе витрина с плитками `capabilities[]` и гейтом плитки по скиллу карточки.
- Сервисы на хосте, регистрирующие свои серии метрик через `hostMetricsRegistry`/`host_metrics_registry`.
- Агенты, экспортирующие себя как MCP Resource Server (`McpToolDef` обязан нести `title`).
- Потребители стрима A2A: `artifact-update`-дельты как `text`-события, терминальный текст из `status.message`, keepalive-`status-update` как признак живого потока.
- Суб-агенты, получающие от релея манифест `context_files` (`mime`, `hasRaw`).
- Агенты на python-хосте с многоходовым A2A-диалогом: persist-state читается из последнего артефакта задачи.
- Потребители durable A2A task store: python — `PostgresTaskStore`, `assert_ready()` на старте, миграция Job'ом, ретенция CronJob'ом; TS — `Ai37TaskStore`, `assertTaskStoreReady()`, CLI `migrate` initContainer'ом, `cleanup` CronJob'ом; сервисы со своей схемой включают `TASK_STORE_EXTERNAL_SCHEMA=true`.
- Потребители владельца задачи из JWT: все сторы разводят задачи по `<org_id>:<sub>`.
- Потребители отмены хода: сервис, прокидывающий `AgentRequest.signal` в `invoke(…, { signal })`.
- Потребители subpath `@ai37/agent-host/dsh`.
- Потребители пакета `ai37-capture-contract`: browser-worker minstroy и рендереры вне кластера (`AI-37/website-scraper`).
- Потребители трассировки Langfuse: при выключенном `LANGFUSE_CAPTURE_CONTENT` в трейс уходят только структура и объёмы. Агенты python-хоста получают turn-спан на A2A-ходе от хоста и не должны оборачивать ход сами (вложенная обёртка откроет второй трейс).
- Потребители маскировки логов: агенты получают правила бампом SDK.
- Первый потребитель интента `document_generation` — `pdai-doc-gen-agent`; первый потребитель генерик-механизма скиллов — `document-service`; потребители кодов биллинга (`daylight-calc-agent`, `hvac-calc-agent` и т.д.).
- Вызывающие гейты, объявленные переменной окружения (модуль `policy`).

## Конфигурация

Ключевые runtime-параметры SDK (см. `contract/env.md`):
- `ISSUER`, `AUDIENCE`, `JWKS_URL` — auth (JWT-verify).
- `leeway`, introspection (`url`/`appsToken`/`cacheTtlMs`) — параметры верификации.
- `requiredClaims` (TS) / `required_claims` (Python) — набор claim, обязательных непустой строкой; дефолт `['sub','org_id','billing_org_id']`.
- `BILLING_BASE_URL` — billing; пустой `appsAuthToken`/`apps_auth_token` — `BillingConfigurationError` → 503 при `required=true`.
- billing-клиент: `authToken` (state, в т.ч. маршрут `by-org`), `usageIngestToken` (`POST /api/v1/events`), `timeoutMs` (дефолт 5000), `runtimeStateCacheTtlMs` (дефолт 5000, `0` — без кэша) — параметры конструктора, не env.
- `llmKey` — из runtime state billing, не из env/JWT; не логировать.
- Подпакеты `policy`, `log-redaction`, `showcase/v1` собственных env-переменных не вводить.

Файлы хода: новых env-переменных нет — `chatBackendUrl`, `bearer` (по умолчанию `currentBearer` из request-scope хоста), `scope`, `budgetChars` (по умолчанию без потолка), `maxTokens`, `timeoutMs` у `extractFromAttachments` (по умолчанию 300 с) — параметры вызовов.

Артефакты хода: новых env-переменных нет — `chatBackendUrl`, `contextId`, `projectId` (без него корпус проекта не загружается), `bearer`, `fetchImpl` — параметры `artifactScope` и `createAttachmentReaders`.

База проекта (все параметры — аргументы функций, env-переменных модуль не читает):
- `uploadToProjectPool`: `documentServiceUrl`, `projectKey` (id проекта chat-backend в нижнем регистре), `fileName`, `projectName?`, `bearer`, `contentType?`, `timeoutMs` (по умолчанию 120 000).
- `findProjectDocumentByTitle`: `documentServiceUrl`, `projectKey`, `title`, `bearer`, `timeoutMs` (по умолчанию 30 000).
- `serviceToken`: `issuer`, `clientId`, `clientSecret`, `scope?`, `timeoutMs` (по умолчанию 15 000).
- `indexToProject`: `chatBackendUrl`, `projectId`, `refs`, `bearer` (по умолчанию `currentBearer`), `timeoutMs` (по умолчанию 120 000).

Трассировка host-слоя (env, общая для TS и Python):
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` (или `LANGFUSE_HOST`).
- `LANGFUSE_CAPTURE_CONTENT` (default `false`): при `false` клиент Langfuse получает маску содержимого; при `true` маска не ставится. Только там, где Langfuse в своём контуре и есть правовое основание.
- `LANGFUSE_TRACING_ENABLED` (default `true`), `LANGFUSE_TRACING_ENVIRONMENT`, `LANGFUSE_RELEASE`.
- Python-хост: трассировка доступна при установленном extra `observability`; без пакета или ключей — no-op.

Host-слой TS:
- `legacyCompat` — опция `createAgentHost` (default `true`).
- `AgentHostOptions.checkpointer` — Postgres-URL для durable графового состояния.
- `AGENT_SKILL_MODULES`, `AGENT_ENABLED_SKILLS` — скиллы.
- `DATABASE_URL` — durable Postgres task store `Ai37TaskStore` и CLI; без него при `NODE_ENV=production` хост не стартует.
- `TASK_STORE_EXTERNAL_SCHEMA` — `true` переводит стор в режим, где схему ведёт сам сервис; явная опция `externalSchema` важнее переменной.
- `NODE_ENV` — обязательность `DATABASE_URL`.
- `AGUI_HEARTBEAT_MS` (default 15000), `A2A_KEEPALIVE_MS` (default 20000).
- `service` — не env: лейбл метрик из `card.name` через `serviceLabel`.

Durable A2A task store python-хоста (env):
- `DATABASE_URL` — для CLI `python -m ai37_agent_host.postgres_task_store migrate|cleanup`.
- `TEST_DATABASE_URL` — только тесты/CI.
- `AI37_AUTH_REQUIRED=false` — владелец задачи анонимный.

Тесты TS-хоста (env):
- `TEST_DATABASE_URL` — живой Postgres для `test/task-store.pg.test.ts` (роль с правом `CREATE DATABASE`); без переменной блок пропускается.
- `REQUIRE_TEST_DATABASE` — `1` в CI: без `TEST_DATABASE_URL` Postgres-тесты падают, а не пропускаются.

CI/публикация:
- `AI37_NPM_TOKEN`, `AI37_PYPI_TOKEN`, `POETRY_HTTP_BASIC_AI37_USERNAME`/`PASSWORD`, `TWINE_USERNAME`/`TWINE_PASSWORD`, `NPM_CONFIG_USERCONFIG`.
- `POETRY_VERSION` (`2.3.2`) и `POETRY_HOME` (`${{ runner.temp }}/poetry`) — установка Poetry в CI/публикации.
- `CI_RUNNER` / `CD_RUNNER` — переменные организации; переопределяются инпутом `runner` (`auto`/`ubuntu-latest`/`ai37-self-hosted`); фолбэк — `ubuntu-24.04` (для части publish-workflow — `ubuntu-latest`).

## Данные и хранилища

— У SDK нет собственной БД/миграций. `policy` и `log-redaction` состояния не хранят; `showcase/v1` — витринные данные самой Agent Card; гибридная карточка (`toPublicAgentCard`) ничего не хранит (`supportedInterfaces` вычисляется при отдаче); коды фич/привилегий — статические константы. Кэш runtime state в billing-клиенте — in-memory LRU/словарь на процесс: ключ `<маршрут>:<id>` (маршруты `by-billing-org` и `by-org` не подменяют друг друга при совпадении id), TTL `runtimeStateCacheTtlMs` (дефолт 5000 мс, `0` — запись удаляется сразу), неудачный запрос не кэшируется. Host-слой использует Redis task store и store-backend'ы. Манифест `metadata.ai37.context_files` несёт хинт-описание файла; тело тянется отдельно по `ref`. Задачи A2A во всех сторах разведены по владельцу (`<org_id>:<sub>`; без JWT — пустой владелец); у `RedisTaskStore` владелец входит в ключ. TS-хост держит задачи в durable Postgres — `Ai37TaskStore` (таблица `public.a2a_tasks`, журнал `a2a_a2a_tasks_migrations`, лок `a2a_migrations_lock`; ключ строки `(tenant, owner, id)`; `id`/`context_id` — `varchar(255) collate "C"`; `cleanup(...)` пачками по `status_last_updated`; в режиме `externalSchema` журнал не требуется). Python-хост — `PostgresTaskStore` (таблица `a2a_tasks`, `id`/`context_id` — `varchar(255)`, `create_table=False`, проверка в `assert_ready()`). Персистентное состояние хода A2A-задачи python-хост держит в data-part артефактов задачи (последний артефакт со `state`). В TS-хосте форма `input-required` едет data-частью `{ a2ui: [...] }` в `status.message`, `metadata.state` — в `metadata`, копия формы — в артефакте `a2ui-<taskId>` только при `legacyCompat`; хост чистит форму прошлого шага, `answer-<taskId>` и `metadata.state`. Стриминговые text-дельты артефакта `answer` — живая проекция ответа; авторитетный текст — `status.message` терминального Task. Durable LangGraph-чекпоинтер пишет графовое состояние в Postgres (`checkpoints`/`checkpoint_blobs`/`checkpoint_writes`/`checkpoint_migrations`); ретенция старых тредов — вне пакета. Файлы хода и артефакты не копируются и не кешируются: читатели ходят в REST chat-backend по `ref` (`/api/chat-attachments`, `/api/project-attachments`, `/api/artifacts`), ничего не пишут, окна чтения и бюджет символов живут в памяти хода; `artifactScope` один раз загружает манифест корпуса, python-хост строит только скоуп. База проекта собственного хранилища не заводит: файл уезжает в пул проекта document-service (ключ пула — id проекта chat-backend), дедупликацию решают DS (sha256) и название артефакта, а `findProjectDocumentByTitle` только читает реестр пула (страницы по `nextCursor`). Служебный токен `serviceToken` живёт в памяти процесса (кеш `tokens`/`pending`/`tokenEndpoints`, ключ — issuer + clientId + scope + sha256 секрета) и никуда не персистится; `indexToProject` состояния не держит. MCP-экспорт и guard'ы собственного хранилища не заводят; факт сбоя проверки — in-process метрика и строка лога. Метрики — in-process реестр prometheus, не персистятся. Трассировка Langfuse собственного хранилища не заводит: содержимое по умолчанию не пишется (метка `{"redacted": true, "chars": N}`), сама трассировка уезжает в Langfuse. Subpath `@ai37/agent-host/dsh` сессии не хранит. `ai37-capture-contract` собственного хранилища не заводит: снимки browser-worker едут в бакет, PNG рендерера — в теле ответа.

## Быстрый старт (локально)

— Отдельного сервиса/локального раннапа в репозитории нет: SDK и host — библиотеки. Host ставится из приватного Verdaccio: `npm i @ai37/agent-host @ai37/agent-sdk`; минимальное использование — `createAgentHost({ card, handler, agentContext })` → `app.listen(8080)` (пример в README `packages/ts-host`). Скиллы подключаются через subpath `@ai37/agent-host/skills`:

```ts
const registry = await buildSkillRegistryFromEnv({ builtin: createSearchDocsSkill() })
createAgentHost({
  card: composeCardWithSkills(buildAgentCard(baseUrl), registry.all()),
  handler: createSkillDispatchHandler(registry),
  // ...
})
```

Agent Card хост отдаёт сам, в гибридной форме (`GET /.well-known/agent-card.json`), поэтому отдельный роут агента для карточки не нужен. Клиенты A2A 0.3 принимаются по умолчанию (`legacyCompat: true`); выключить — `createAgentHost({ legacyCompat: false })`. Guard'ы fail-closed настраиваются тем же `agentContext.auth.required` (default `true`); нужен непустой `billing.appsAuthToken`, иначе запрос с токеном получит 503 `auth_unavailable` (MCP — JSON-RPC `-32603`).

Файлы хода (корневой экспорт `@ai37/agent-host`): скоуп из `context_refs`/`context_files`, чтение в бюджет и извлечение одним LLM-вызовом.

```ts
import {
  attachmentScope,
  createAttachmentReaders,
  extractFromAttachments,
  readAttachmentContents,
} from '@ai37/agent-host'

const scope = attachmentScope({ contextId, contextRefs, contextFiles })
const readers = createAttachmentReaders({ chatBackendUrl, scope }) // bearer по умолчанию — currentBearer
const { contents, failures } = await readAttachmentContents(readers, { budgetChars: 40_000 })

const extracted = await extractFromAttachments({
  llmKey: ctx.llmKey,
  baseUrl: llmBaseUrl,
  model: 'gpt-4o-mini',
  systemPrompt: 'Извлеки исходные данные. Если нужного нет — ответь ровно «нет данных».',
  query,
  contents,
})
// extracted: string | null (нет файлов / пустой ответ / «нет данных» → null; ошибка вызова пробрасывается)
```

Артефакты хода (`@ai37/agent-host` `0.4.0`): корпус загружается один раз, читатели принимают его наравне с файлами хода:

```ts
import { artifactScope, createAttachmentReaders } from '@ai37/agent-host'

const artifacts = await artifactScope({ chatBackendUrl, contextId, projectId })
const readers = createAttachmentReaders({ chatBackendUrl, scope, artifacts })
await readers.read('project-artifact:<id>', { offset: 0, limit: 200 })
```

База проекта: загрузка в пул DS, служебный токен и мост chat-backend:

```ts
import {
  findProjectDocumentByTitle,
  indexToProject,
  serviceToken,
  uploadToProjectPool,
} from '@ai37/agent-host'

// фоновая задача: служебный клиент Authentik, токен кэшируется до истечения
const bearer = await serviceToken({ issuer, clientId, clientSecret })
const res = await uploadToProjectPool({ documentServiceUrl, projectKey, file, fileName, bearer })
// { seriesId } или { duplicateOf: { id, title } } — тот же файл уже в пуле

await findProjectDocumentByTitle({ documentServiceUrl, projectKey, title: 'Протокол расчёта', bearer })

await indexToProject({ chatBackendUrl, projectId, refs: ['project-artifact:…'] }) // JWT пользователя
```

Отказы: `ProjectPoolError` с кодом DS (`pool_not_found`, `documents_not_in_plan`, …; у `upload_busy` — `retryAfterSeconds`), `ServiceTokenError` и `ProjectKnowledgeError` с машинным кодом; текст ответа и имя файла в сообщение не попадают.

State продукта по организации (SDK, для сервисов без user-JWT):

```ts
import { createBillingClient } from '@ai37/agent-sdk'

const billing = createBillingClient({ baseUrl, authToken: appsToken, usageIngestToken: appsToken })
const state = await billing.getRuntimeStateByOrgId(orgId) // GET .../customers/by-org/{orgId}/state
// state.entitlementStatus, state.llmKey, state.features — как у state по billingOrgId
```

```python
from ai37_agent_sdk import create_billing_client

billing = create_billing_client(
    base_url=base_url, auth_token=apps_token, usage_ingest_token=apps_token
)
state = billing.get_runtime_state_by_org_id(org_id)
```

Скоуп файлов хода в python-хосте (`ai37-agent-host` `0.1.0a27`):

```python
from ai37_agent_host.store_backend import attachment_scope, has_file_refs

if has_file_refs(context_refs):
    scope = attachment_scope(context_id, context_refs, context_files)
    # scope.files: list[AttachmentFile]; scope.project_id — из project:<id>
```

Логи агента очищаются от секретов: в TS логгер собирается `pino(agentLoggerOptions({ level, name }))`, в Python на handler ставится `SecretRedactingFilter()`.

```ts
import pino from 'pino'
import { agentLoggerOptions, redactForLog } from '@ai37/agent-sdk'

const log = pino(agentLoggerOptions({ level: 'info', name: 'my-agent' }))
log.info({ state }, 'handler.run OUT') // JWT / llmKey / sk-… в лог не попадут
```

```python
import logging
from ai37_agent_sdk import SecretRedactingFilter, redact_for_log

logging.getLogger().addFilter(SecretRedactingFilter())
logging.info("state=%s", redact_for_log({"state": state}))
```

Звать другого агента — через relay и готовую фабрику клиентов (compat 0.3 на клиенте включён всегда):

```ts
import { createAi37ClientFactory, executeRemoteA2a } from '@ai37/agent-host/relay'

const client = await createAi37ClientFactory(fetchWithAuth).createFromUrl(agentBaseUrl)
const res = await executeRemoteA2a(client, { query, contextId, resumeTaskId })
// res.state: 'completed' | 'input-required' | 'failed' | 'message' (строки 0.3)
// res.a2ui: форма паузы — из status.message, затем из артефакта a2ui-<taskId>, затем из metadata.a2ui
```

Для durable графового состояния в `createAgentHost` передаётся `checkpointer`, собранный фабрикой `createCheckpointer({ databaseUrl })`. Durable Postgres-стор A2A-задач — через subpath `@ai37/agent-host/task-store` (`kysely` и `pg` — optional peers):

```ts
import { createAgentHost } from '@ai37/agent-host'
import { assertTaskStoreReady, createTaskStoreFromEnv } from '@ai37/agent-host/task-store'

const taskStore = createTaskStoreFromEnv() // DATABASE_URL → Ai37TaskStore; без него в production — ошибка, в dev/тестах — InMemoryTaskStore
await assertTaskStoreReady(taskStore)       // нет таблицы / чужая / узкие колонки → под не стартует
createAgentHost({ card, handler, agentContext, taskStore }).listen(8080)
```

CLI схемы и ретенции (строка подключения — только из `DATABASE_URL`):

```bash
DATABASE_URL=postgres://... npx --no-install ai37-agent-host-task-store migrate
DATABASE_URL=postgres://... npx --no-install ai37-agent-host-task-store check
DATABASE_URL=postgres://... npx --no-install ai37-agent-host-task-store cleanup --terminal-days 7 --stale-days 14
```

Если схему таблицы ведёт сам сервис (база под Prisma), стор переводится в режим `externalSchema` переменной `TASK_STORE_EXTERNAL_SCHEMA=true` или опцией `externalSchema`:

```bash
TASK_STORE_EXTERNAL_SCHEMA=true DATABASE_URL=postgres://... npx --no-install ai37-agent-host-task-store check
```

В этом режиме `check` и `cleanup` проверяют таблицу, колонки и ширину `id`/`context_id` без журнала `a2a_a2a_tasks_migrations`, а `migrate` отказывается (exit 1); миграция сервиса обязана повторять DDL `migrate`.

Свою серию метрик сервис регистрирует в реестре хоста:

```ts
import { Gauge } from 'prom-client'
import { hostMetricsRegistry, serviceLabel } from '@ai37/agent-host'

new Gauge({ name: 'my_service_queue_depth', help: 'Глубина очереди сервиса', registers: [hostMetricsRegistry] })
```

```python
from prometheus_client import Gauge
from ai37_agent_host import host_metrics_registry, service_label

Gauge('my_service_queue_depth', 'Глубина очереди сервиса', registry=host_metrics_registry)
```

MCP-экспорт включается опцией `mcp` у `createAgentHost` — каждому инструменту обязателен `title`:

```ts
createAgentHost({
  card,
  handler,
  mcp: {
    tools: [
      {
        name: 'calc_lifts',
        title: 'Расчёт лифтов по ГОСТ',
        description: 'Расчёт лифтов',
        annotations: { readOnlyHint: true, idempotentHint: true },
        handler: (args, extra, signal) => ({ content: [{ type: 'text', text: String(args.query) }] }),
      },
    ],
    scopes: ['mcp'],
  },
})
```

Трассировка Langfuse в python-хосте (extra `observability`):

```bash
pip install "ai37-agent-host[observability]"
```

Хост сам открывает turn-спан на каждый ход (A2A — `{service}:a2a`, и AG-UI), когниция берёт колбэки через `current_langfuse_callbacks()`; оборачивать ход в `with_turn_observability` самому не нужно. Включается ключами `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` (+ `LANGFUSE_BASE_URL`), содержимое хода не пишется без `LANGFUSE_CAPTURE_CONTENT=true`.

Durable A2A task store в python-хосте (extra `postgres`):

```bash
pip install 'ai37-agent-host[postgres]'
```

```python
from ai37_agent_host import create_agent_host
from ai37_agent_host.postgres_task_store import PostgresTaskStore, create_engine

store = PostgresTaskStore(create_engine(os.environ['DATABASE_URL']))
await store.assert_ready()
app = create_agent_host(card=..., handler=..., agent_context=..., task_store=store)
```

CLI для Helm-хука и CronJob:

```bash
DATABASE_URL=postgres://... python -m ai37_agent_host.postgres_task_store migrate
DATABASE_URL=postgres://... python -m ai37_agent_host.postgres_task_store cleanup --terminal-days 7 --stale-days 30
```

Обвязка DSH (subpath `@ai37/agent-host/dsh`):

```ts
import { SingleHarnessRuntime } from '@ai37/agent-host/dsh'

// createHarness должен вернуть запущенный экземпляр с асинхронным close().
const runtime = new SingleHarnessRuntime(() => createHarness())
const result = await runtime.use((harness) => harness.run(prompt))
await runtime.close()
```

Верификатор с сокращённым набором обязательных claim и разбор env-политики:

```ts
createJwtVerifier({ issuer, audience, jwksUrl, requiredClaims: ['sub'] })
const ADMIN = { states: ['relaxed', 'attributed', 'closed'] as const, fallback: 'closed' as const }
const mode = readPolicyState('ADMIN_CONTENT_READ', ADMIN)
```

```python
JwksJwtVerifier(issuer=..., audience=..., jwks_url=..., required_claims=['sub'])
ADMIN = PolicyStateOptions(states=('relaxed', 'attributed', 'closed'), fallback='closed')
mode = read_policy_state('ADMIN_CONTENT_READ', ADMIN)
```

Витринное расширение карточки `showcase/v1` с режимами-плитками `capabilities[]` (у плитки может быть ссылка `skill` на скилл той же карточки):

```ts
const showcase = buildAgentShowcaseExtension({
  title: 'Расчёт лифтов',
  summary: 'Подбор числа и параметров лифтов по этажности и заселённости',
  computes: 'Число лифтов, интервал движения, провозная способность группы',
  norms: [{ code: 'ГОСТ 34758-2021', title: 'Лифты. Определение числа, параметров и размеров лифтов' }],
  starter: 'Запусти расчёт лифтов',
  examples: ['Подбери лифты для жилого дома 17 этажей'],
  order: 3,
  capabilities: [
    { id: 'lift-count', title: 'Подбор лифтов', summary: 'Число и параметры лифтов по этажности', skill: 'lift-count' },
  ],
})
```

Манифест вложения с `mime`/`hasRaw`:

```json
{
  "ref": "chat-attachment:1",
  "name": "list.xlsx",
  "scope": "chat",
  "isLarge": true,
  "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "hasRaw": true
}
```

Доменный пакет `ai37-capture-contract` поднимается локально как обычный poetry-проект:

```sh
cd packages/capture-contract
poetry install
poetry run pytest && poetry run mypy src && poetry run ruff check .
```

У хоста есть health-эндпоинт `/api/v1/health` (и `/api/v1/version`) — реальная smoke-проверка поднятого хоста; `GET /metrics` отдаёт серии метрик (в т.ч. `ai37_agent_auth_guard_errors_total`); `GET /.well-known/agent-card.json` отдаёт гибридную карточку. Проверка собранного пакета ts-host — `npm run test:package` из `packages/ts-host`. Параметры окружения описаны в `contract/env.md`; отдельного шаблона `.env` в материалах нет.

## Как запускать тесты

```bash
make codegen   # кодоген codes.ts/codes.py из contract/feature-codes.json
make ts        # TS: lint + test + build
make ts-docx   # TS: @ai37/docx (lint + test + build)
make py        # Python: ruff + mypy + pytest
make capture-contract  # ai37-capture-contract: ruff + ruff format --check + mypy + pytest
make verify    # codegen-парити + все перечисленные пакеты
```

Для `packages/ts` (package.json): `npm test` (vitest run) — включая `test/a2a.test.ts`, `test/auth.test.ts` (`requiredClaims`), `test/billing.test.ts` (в т.ч. блок `getRuntimeStateByOrgId`: маршрут `by-org` и токен, кодирование id в пути, кэш в пределах TTL и отсутствие кэша при `ttl=0`, разведение ключей `by-org`/`by-billing-org` при одинаковом id, типизированная ошибка с `orgId=<id>` без кэширования сбоя, `InMemoryBillingClient` по `orgId`), `test/policy.test.ts`, `test/showcase.test.ts` (обрезка по кодовым точкам, `capabilities[]` и ссылка `skill`), `test/log-redaction.test.ts`, `test/context-log-view.test.ts`, `test/codes.test.ts` (паритет перечислений с `contract/feature-codes.json`); `npm run verify` (`lint` + `test` + `build`).

Для `packages/ts-host` дополнительно: `npm test` (vitest) — `test/agent-card.test.ts`, `test/host.test.ts`, `test/legacy-request.test.ts` (семантика 0.3: `blocking` по умолчанию, SSE только для ошибок протокола со статусом 200), `test/auth-guard.test.ts` (fail-closed 503 и метрика), `test/langfuse-content.test.ts` (метка строкой JSON, `traceMetadata` как есть, `isLangfuseContentCaptured`), `test/final-task-events.test.ts`, `test/relay.test.ts`, `test/compat-mixed-fleet.test.ts`, `test/skills.test.ts`, `test/checkpointer.test.ts`, `test/mcp.test.ts`, `test/metrics-export.test.ts`, `test/a2a-text-stream.test.ts`, `test/attachments-helpers.test.ts` (скоуп из refs+манифеста без дублей и `projectId`, отказ читать ref не из скоупа без похода в сеть, окна `readWithinBudget` и бюджет `readAttachmentContents`, `grep` только по файлам хода, `attachmentFailureReason`, поведение `extractFromAttachments`/`extractionRequest`/`messageText`), `test/attachments-artifacts.test.ts` (`artifactScope`: артефакты треда и проекта с явным bearer, без проекта — без запроса к проекту, недоступный список → `errors` и пустая полка; читатели с `artifacts`: чужой ref не читается и в сеть не ходит, артефакты добавляются к файлам хода, окно читается по id без корпуса, `grep` по FTS корпусов с фильтром по загруженным, `readAttachmentContents` читает артефакты наравне с вложениями), `test/project-knowledge.test.ts` (заголовки и тело `uploadToProjectPool` включая поток и `Content-Length` на настоящем сервере, `409 duplicate` → `duplicateOf`, `upload_busy` с `Retry-After` и из тела, коды DS без текста ответа в сообщении, `network_error`/`upstream_error`; `findProjectDocumentByTitle` — точное совпадение из подстрочной выдачи, пагинация по `nextCursor`, отказ DS; `serviceToken` — discovery и `client_credentials`, кеш до истечения и обновление, ошибки; `indexToProject` — результаты по ref и отказ запроса целиком), `test/task-store.unit.test.ts`, `test/task-store.pg.test.ts` (включая блок `externalSchema`/`TASK_STORE_EXTERNAL_SCHEMA`), `test/dsh-*.test.ts` и `npm run verify` (`lint` + `format:dsh:check` + `test` + `build` + `test:package`). Отдельно: `npm run lint:dsh`, `npm run format:dsh:check`. `scripts/check-dsh-package.mjs` проверяет корневой импорт распакованного пакета — в списке обязательных функций теперь и `artifactScope`, `uploadToProjectPool`, `findProjectDocumentByTitle`, `serviceToken`, `indexToProject`, `ProjectPoolError`, `ServiceTokenError`, `ProjectKnowledgeError`. `test/task-store.pg.test.ts` идёт против настоящего Postgres (`TEST_DATABASE_URL`, роль с правом `CREATE DATABASE`), без переменной блок пропускается, при `REQUIRE_TEST_DATABASE=1` — ошибка. Локально:

```bash
docker run -d --name ts-host-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55471:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55471/postgres npm test
docker rm -f ts-host-pg
```

Для `packages/python` — pytest (testpaths `tests`): `tests/test_a2a.py`, `tests/test_auth.py`, `tests/test_billing.py` (в т.ч. `get_runtime_state_by_org_id`: маршрут `by-org`, кодирование id, кэш и `ttl=0`, разведение ключей маршрутов, `BillingRequestError` с `orgId=<id>` без кэширования сбоя, `InMemoryBillingClient` по `orgId`), `tests/test_policy.py`, `tests/test_showcase.py`, `tests/test_context.py`, `tests/test_log_redaction.py`, `tests/test_codes.py`.

Для `packages/capture-contract` (poetry, testpaths `tests`): `make capture-contract` или вручную:

```sh
cd packages/capture-contract
poetry install --with dev
poetry run ruff check . && poetry run ruff format --check . && poetry run mypy src && poetry run pytest
```

Для `packages/python-host` — pytest (asyncio_mode `auto`): `tests/test_auth_guard.py` (fail-closed 401/503, лог без секретов, метрика), `tests/test_langfuse_mask.py` (маска содержимого, `trace_metadata` как есть, `is_langfuse_content_captured`), `tests/test_langfuse_turn.py` (turn-спан на A2A-ходе: `{service}:a2a`, колбэки в ALS, `session_id`/`user_id`, наследование входящего `traceparent`, фолбэк на `metadata.ai37.trace_id`; настоящий клиент langfuse v5 против заглушки OTLP; пустые поля не уходят в `propagate_attributes`; медленный flush не задерживает ход; no-op без ключей и без пакета), `tests/test_langfuse_noop.py`, `tests/test_parse.py` (в т.ч. `trace_carrier` с `tracestate`/`baggage`), `tests/test_metrics_export.py`, `tests/test_checkpointer.py`, `tests/test_executor_streaming.py`, `tests/test_executor_text_stream.py`, `tests/test_prior_state.py`, `tests/test_mcp_server.py`, `tests/test_mcp_bridge.py`, `tests/test_relay_execute.py`, `tests/test_owner.py`, `tests/test_postgres_task_store.py` (SQLite всегда, живой Postgres при `TEST_DATABASE_URL`), `tests/test_turn_files.py` (слияние refs и манифеста без дублей, имя файла по ref без манифеста, пустой ход, `has_file_refs`/`project_id_from_refs`). Раннер джоб выбирается инпутом `runner` → переменная `CI_RUNNER` → фолбэк `ubuntu-24.04`.

## Деплой

Библиотеки, не сервис: Helm/terraform не используются; публикация — в приватные реестры AI37 через GitHub Actions вручную (`workflow_dispatch`, опция `dry_run`). Workflow публикации: `publish-ts.yml`, `publish-python.yml`, `publish-ts-host.yml`, `publish-python-host.yml`, `publish-ts-docx.yml`, `publish-capture-contract.yml`. Текущие версии: `@ai37/agent-sdk` — `0.1.0-alpha.36`, `ai37-agent-sdk` — `0.1.0a28`, `@ai37/agent-host` — `0.4.0` (subpaths `./relay`, `./skills`, `./task-store`, `./dsh`, bin `ai37-agent-host-task-store`), `ai37-agent-host` — `0.1.0a27` (extras `redis`, `postgres`, `observability`), `ai37-capture-contract` — `0.1.0`, `@ai37/docx` — `0.1.0-alpha.1`.

**dist-tag по версии (все npm-publish workflow).** Дистрибутивный тег вычисляется из `package.json`: пререлиз (`0.1.0-alpha.N`) → `alpha`, релиз (`0.2.0`) → `latest`; шаг `dist-tag` пишет `tag` в `$GITHUB_OUTPUT`, `npm publish --tag …` используется и при `--dry-run`. Из `publishConfig` пакетов `@ai37/agent-host` и `@ai37/docx` поле `tag: alpha` убрано. Выбор раннера — инпут `runner` (`auto` / `ubuntu-latest` / `ai37-self-hosted`) важнее переменной организации (`vars.CI_RUNNER` в `ci.yml`, `vars.CD_RUNNER` в `publish-*.yml`); фолбэк — `ubuntu-24.04` (в `publish-python-host.yml` и `publish-capture-contract.yml` — `ubuntu-latest`).

- **npm (`@ai37/agent-sdk`, `@ai37/agent-host`, `@ai37/docx`)** — приватный Verdaccio `https://npm.app.sp-ai.ru/`. Аутентификация — HTTP Basic через закоммиченный корневой `.npmrc`; в CI задаётся `NPM_CONFIG_USERCONFIG`. `prepublishOnly` выполняет `npm run verify`.
- **PyPI (`ai37-agent-sdk`, `ai37-agent-host`, `ai37-capture-contract`)** — приватный PyPI `https://pypi.app.sp-ai.ru/`: `poetry build`, `twine check`/`twine upload` с `TWINE_USERNAME=ci-publish` и `TWINE_PASSWORD=${{ secrets.AI37_PYPI_TOKEN }}`. Для `python-host` приватный источник `ai37` в `pyproject.toml`; `POETRY_HTTP_BASIC_AI37_USERNAME=ci-read` / `POETRY_HTTP_BASIC_AI37_PASSWORD`. Poetry ставится официальным установщиком `install.python-poetry.org` с `POETRY_VERSION=2.3.2` и `POETRY_HOME=${{ runner.temp }}/poetry`; `twine` — `python -m pip install twine`.

**Схема Postgres-стора TS-хоста — шагом деплоя.** В чарте агента: `DATABASE_URL` из runtime-секрета terraform; initContainer `migrate` перед основным контейнером (тот же образ, `npx --no-install ai37-agent-host-task-store migrate`; параллельный запуск реплик безопасен — разводит лок мигратора); CronJob `task-store-retention` раз в сутки (`cleanup --terminal-days ... --stale-days ...`), метки пода Job'а — НЕ `selectorLabels`. В режиме `TASK_STORE_EXTERNAL_SCHEMA=true` initContainer `migrate` не нужен — команда откажет с exit 1; схему создаёт миграция самого сервиса (для chat-backend — Prisma-миграция таблицы `a2a_tasks`, повторяющая DDL `migrate`).

Выпуском `@ai37/agent-host` `0.4.0` добавлена «база проекта» и артефакты хода: `uploadToProjectPool`, `findProjectDocumentByTitle`, `serviceToken`, `indexToProject`, `artifactScope`, `artifacts` у `createAttachmentReaders`, публичный `ArtifactsStoreBackend.list()`, `AttachmentFile.kind`. Новых env-переменных выпуск не добавляет (все параметры — аргументы функций), шагов деплоя — тоже: загрузка идёт в существующий пул проекта document-service, мост — в маршрут chat-backend `POST /api/project-knowledge`. Фоновым задачам, грузящим в пул без пользователя, нужен клиент `client_credentials` в Authentik (issuer + clientId/clientSecret передаёт сервис).

Выпуском `@ai37/agent-host` `0.3.0` / `ai37-agent-host` `0.1.0a27` файлы хода собираются в хосте: `attachmentScope` из `context_refs` и манифеста, читатели по ref (окна, `grep`, бюджет символов), `readAttachmentContents` и `extractFromAttachments`; в python-хосте портирован только скоуп. `0.3.1` добавил `maxTokens` у `extractFromAttachments` и `readStoreWithinBudget`.

Выпуском `@ai37/agent-host` `0.2.7` subpath `@ai37/agent-host/dsh` объявлен поддерживаемым Node.js API host-слоя; в CI пакета добавлены `lint:dsh`, `format:dsh:check` и `test:package`.

Выпуском `@ai37/agent-host` `0.2.6` / `ai37-agent-host` `0.1.0a25` закрыта устойчивость цепочки UI → chat-backend → агенты → LiteLLM: `Ai37ChatCompletions` с одной попыткой сверху и `timeout` 180 с (429 не повторяется), heartbeat AG-UI, keepalive A2A, таймауты relay, сквозная отмена хода.

Выпуском `ai37-agent-host` `0.1.0a26` включена наблюдаемость A2A-хода: turn-спан `{service}:a2a` в `HostExecutor`, продолжение трейса оркестратора по входящему `traceparent` (собственный SERVER-спан `a2a-sdk` родителем не считается), чтение `tracestate`/`baggage`, фоновый `flush` без блокировки event loop, `propagate_attributes` без `None`, extra `observability` с `langfuse>=5.0,<6`. Агентам, которые оборачивали ход сами, обёртку нужно убрать: вложенный вызов откроет второй turn-спан корнем отдельного трейса.

Выпусками `@ai37/agent-sdk` `0.1.0-alpha.36` / `ai37-agent-sdk` `0.1.0a28` в billing-клиент добавлен state продукта по организации: `getRuntimeStateByOrgId(orgId)` / `get_runtime_state_by_org_id(org_id)` ходит на маршрут billing `GET /api/v1/billing/customers/by-org/{orgId}/state` (нужен сервисам, у которых есть только `org_id`; продукт billing берёт из токена, аккаунт биллинга находит сам). Кэш общий с `getRuntimeStateByBillingOrgId`, ключи разведены по маршруту (`<маршрут>:<id>`), ошибки — прежние (`BillingRequestError` с `orgId=<id>` в тексте). Метод требует, чтобы маршрут `by-org` был выкачен в billing; новых env-переменных и шагов деплоя выпуск не добавляет. Ранее выпусками `0.1.0-alpha.35` / `0.1.0a27` заведены фича `polimetrika-data-agent` и привилегия `polimetrika-data-agent-allowed`; `0.1.0-alpha.34` / `0.1.0a26` — привилегия `pdai-audit-assist-allowed`; `0.1.0-alpha.33` / `0.1.0a25` — фича `document-search-agent`, привилегия `document-search-allowed` и опциональное `skill` у возможности `showcase/v1`; `0.1.0-alpha.32` / `0.1.0a24` — маскировка секретов в логах SDK.

Ранее: выпуском `@ai37/agent-host` `0.2.5` / `ai37-agent-host` `0.1.0a24` доведена маска содержимого Langfuse; `0.2.4` — совместимость с клиентами 0.3 и очистка `answer-<taskId>`; `0.2.3` / `0.1.0a23` — fail-closed guard'ы; `0.2.2` — режим `externalSchema`; `0.2.1` — durable Postgres-стор задач и CLI; `0.2.0` — переезд TS-хоста на `@a2a-js/sdk` ^1.3.0.

## Связанные документы

- `ecosystem/v2/09-agent-runtime.md` — рантайм агентов (трассировка Langfuse и её маска содержимого, логи и маскировка секретов, heartbeat AG-UI, keepalive A2A, отмена хода, опциональный `.dsh`-адаптер хоста).
- `ecosystem/v2/04-a2a-conventions.md` — A2A-конвенции, конверт `metadata.ai37` и манифест `context_files`; раздел «Per-skill биллинг».
- `ecosystem/v5/03-tool-contract.md` — контракт MCP-инструмента (`title` обязателен).
- `plans/ts-a2a-sdk-1x-database-task-store.md` — план переезда TS-хоста на `@a2a-js/sdk` 1.x и durable task store.
- `plans/polimetrika-cabinet-v1-data-agent.md` (репозиторий docs) — план кабинета Полиметрики (фича и привилегия `polimetrika-data-agent`).
- `docs/plans/search-agent-chat-attachments.md` — план «файлов хода без виртуальной ФС», из которого пришли `@ai37/agent-host` `0.3.0` (срез 0a) и паритет `ai37-agent-host` `0.1.0a27`.
- `docs/plans/project-knowledge-bridge.md` — план «базы проекта» (срез 1a — маршрут billing `by-org` и state по `org_id`; срез 2 — загрузчик в пул DS, служебный токен и артефакты хода; срезы 3/4/6 — мост chat-backend, поиск и фоновые отчёты), AI-37/docs#556.
- `contract/feature-codes.json` (в этом репозитории) — источник истины для `BillingFeatureCode`/`BillingPrivilegeCode`, из него кодогенятся `packages/ts/src/codes.ts` и `packages/python/src/ai37_agent_sdk/codes.py`.
- `contract/a2a-showcase-extension.schema.json` и `contract/a2a-showcase-extension.vectors.json` (в этом репозитории) — схема и общие тест-векторы `showcase/v1`.
- `packages/ts-host/README.md` (в этом репозитории) — README host-слоя: DSH-subpath, трассировка, multi-turn/HITL, task-store, деплой, корпус артефактов хода и раздел «База проекта: пул проекта в document-service».
- `packages/python-host/README.md` (в этом репозитории) — README python-хоста: трассировка Langfuse (extra `observability`, turn-спан на A2A, фоновый flush), `PostgresTaskStore` и CLI.
- `packages/capture-contract/README.md` (в этом репозитории) — README доменного пакета `ai37-capture-contract`.
- `docs/plans/agent-showcase-from-agent-card.md`, `docs/plans/agent-showcase-capabilities.md`, `docs/plans/agent-catalog-entitled-only.md`, `docs/plans/agent-log-secret-redaction.md` — планы расширений `showcase/v1`, гейта по скиллу и маскировки логов.
- `https://github.com/AI-37/docs/pull/533` — план, из которого пришёл первый инфраструктурный срез `@ai37/agent-host/dsh`.
- `docs/migrate-to-private-registry-plan.md` (в этом репозитории) — план приватизации npm/PyPI-реестров и git-репозиториев org `AI-37`.
<!-- ai37:card:end -->

<!-- Ниже — только уникальный человеческий контекст (замысел, инварианты, грабли).
     Не дублируйте сюда «что/как» из карточки выше — её ведёт docs-bot из кода. -->

SDK для **агентов** экосистемы **AI37**. Закрывает четыре сквозные задачи, которые иначе каждый агент
реализует по-своему:

- **auth** — верификация входящего **user-JWT** по JWKS (issuer/audience/exp, кэш ключей);
- **billing** — runtime state + metered usage через billing-сервис (entitlement, остаток токенов,
  ключ LLM-шлюза `llmKey`);
- **a2a** — **forward** того же user-JWT при вызове другого агента по A2A;
- **AgentContext** — sugar над auth+billing (verify → preflight → usage);
- **testing kit** — фейки, фикстуры и тест-токены, чтобы агенты тестировались без внешних сервисов.

Монорепо, две реализации с **общим контрактом** (`contract/`), идентичные по именам и семантике:

| Пакет | Реестр | Путь | Статус |
|---|---|---|---|
| `@ai37/agent-sdk` | npm | `packages/ts` | реализован: auth, billing, a2a, AgentContext, testing, CLI |
| `ai37-agent-sdk` | PyPI | `packages/python` | реализован: auth, billing, a2a, AgentContext, testing (CLI — follow-up) |

> **Это resource-server / agent SDK.** Он *проверяет* и *форвардит* уже выданный токен, но **не
> выполняет OIDC-логин** (Authorization Code + PKCE, обмен code, refresh, сессия) — это сторона
> клиента/UI. Host-слой агента (HTTP + A2A + AG-UI) — отдельный пакет `@ai37/agent-host`.

## Где SDK в работе агента

```mermaid
flowchart LR
  C["Вызывающий<br/>(UI / другой агент)"] -->|"A2A: Bearer user-JWT"| AG["Агент<br/>(AgentContext)"]
  AG -->|"auth.verify"| J["JWKS"]
  AG -->|"billing preflight + usage"| B["billing"]
  AG -->|"apiKey = llmKey"| L["LLM-шлюз"]
  AG -->|"a2a.forward user-JWT"| S["суб-агент"]
```

| Что делает агент | Модуль SDK |
|---|---|
| Проверить входящий JWT + биллинг (preflight/usage) | **`AgentContext`** (auth + billing) |
| Вызвать другого агента по A2A (forward токена) | **`a2a`** (`buildA2AAuthHeaders` / `forwardAuthFetch`) |
| LLM-вызов оплачиваемой моделью | `llmKey` из runtime state → apiKey к LLM-шлюзу |
| Тесты без сети | **`testing`** (фейки/фикстуры/токены) |

## Вне scope

- **OIDC-логин (Relying Party):** Authorization Code + PKCE, обмен code, refresh, сессия — сторона
  клиента/UI. SDK только *проверяет* и *форвардит* уже выданный токен.
- **Token-exchange / делегированные токены** — не реализуем (forward того же user-JWT).
- **Host-слой агента** (HTTP + A2A + AG-UI) — пакет `@ai37/agent-host` поверх этого SDK.

## Безопасность

Никогда не логировать секреты: `Authorization`, `llmKey`, `authToken`. Ключ LLM-шлюза берётся
**только** из runtime state (preflight), не из JWT/тела.

## Контракт и разработка

- **Контракт (источник истины):** [`contract/`](contract/) — claims, runtime state, feature-codes,
  env. Кодоген `codes` в оба пакета: `make codegen`.

```bash
make codegen     # contract/feature-codes.json → codes.ts + codes.py
make ts          # сборка/тесты TS-пакета
make py          # сборка/тесты Python-пакета (Python 3.11+ / poetry)
make verify      # codegen-парити + оба пакета
```

Статус: **0.1.0-alpha**.
