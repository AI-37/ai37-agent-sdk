# ai37-agent-sdk

<!-- ai37:card:start (managed by doc-bot — do not edit inside) -->
# ai37-agent-sdk

## Описание
Монорепо общих библиотек для агентов AI37. SDK (`@ai37/agent-sdk` для TS, `ai37-agent-sdk` для Python) проверяет user-JWT по JWKS, делает billing preflight и отправляет metered usage (runtime state, `llmKey`, гейт по `entitlementStatus`), форвардит тот же user-JWT при вызове суб-агента по A2A и даёт обёртку `AgentContext`. Runtime state можно запросить с `subject` — тогда billing добавляет блок с ролью и группами пользователя в организации (`BillingRuntimeSubject`), а кэш state ведётся отдельно на каждого пользователя. Поверх SDK лежит host-слой (`@ai37/agent-host` / `ai37-agent-host`): HTTP-сервер агента с A2A, AG-UI, MCP (MCP Apps — view-ресурсы и `_meta.ui` инструментов, плюс инструкции сервера в ответе `initialize`) и Postgres task store, плюс модуль project-knowledge (пул проекта document-service, служебный токен, мост chat-backend). В host-слое есть построитель «A2UI внутри MCP App» (`a2uiApp` / `a2ui_app`): агент даёт чистые функции хода формы, построитель собирает инструмент формы, app-only инструмент действий и ресурс view, а также проверку доступа и учёт по тем же правилам, что у A2A-пути агента. Оба слоя умеют локаль хода: язык пользователя едет в конверте `metadata.ai37.locale`, разрешается по цепочке до claim и переиспользуется хостом для текстов-фолбэков, инструкции LLM и форварда суб-агенту. Хост также читает персональные инструкции пользователя из конверта `metadata.ai37.user_instructions` (их ставит только оркестратор из своей БД), нормализует и отдаёт когниции через `currentUserInstructions()` / `withUserInstructions()`; из AG-UI `forwardedProps` поле не берётся, relay форвардит его суб-агенту. Расширения Agent Card `showcase/v1` и `routing/v1` поддерживают необязательные переводы `i18n` (тег BCP-47 → текст или фразы); выбор варианта по локали хода — `localizeAgentShowcaseProfile` / `localizeAgentRoutingProfile` (`localize_agent_showcase_profile` / `localize_agent_routing_profile` в Python). В том же монорепо публикуются два вспомогательных пакета: `@ai37/docx` (markdown → DOCX) и `ai37-capture-contract` (контракт захвата карточки товара для мониторинга цен). SDK не выполняет OIDC-логин: он только проверяет и форвардит уже выданный токен.

## Стек
- TypeScript, Node ≥ 22, npm, tsup, vitest: `@ai37/agent-sdk` (0.1.0-alpha.40), `@ai37/agent-host` (0.12.0), `@ai37/docx` (0.1.0-alpha.2).
- `@ai37/agent-host`: `@a2a-js/sdk` ^1.3.0, Express 4, `@ag-ui/core`/`@ag-ui/encoder`, `@ai37/a2ui-catalog-schemas` ^0.10.0, `prom-client`, Langfuse/OpenTelemetry; peer-зависимости (все опциональные, кроме `@ai37/agent-sdk`): `@ai37/agent-sdk` (≥ 0.1.0-alpha.38), `@ai37/a2ui-mcp-app` (≥ 0.50.0), LangChain/LangGraph checkpoint (+postgres), `@modelcontextprotocol/sdk` (≥ 1.26.0), `kysely`, `pg`, `zod`; в devDependencies — `@modelcontextprotocol/sdk` ^1.29.0, `@ai37/a2ui-mcp-app` ^0.50.0 и `undici` ^7.30.2 (тесты воспроизводят глобальный диспетчер npm-undici 7).
- Python ≥ 3.11, poetry 2.3.2, ruff, mypy, pytest: `ai37-agent-sdk` (0.1.0a32; pyjwt[crypto], httpx), `ai37-agent-host` (0.1.0a40; `a2a-sdk` ≥ 1.1.0, FastAPI/Starlette, sse-starlette, prometheus-client; extras `redis`, `postgres` (SQLAlchemy async + asyncpg), `observability` (langfuse ≥ 5,< 6), `a2ui` (`ai37-a2ui-catalog` ≥ 0.50.0, ставится только на Python ≥ 3.13); dev-группа — `mcp` ≥ 1.27,< 2, которым MCP-поверхность проверяется настоящим клиентом SDK, и `ai37-a2ui-catalog` ≥ 0.50.0 для тестов построителя A2UI). `ai37-agent-host` зависит от `ai37-agent-sdk` версионным ограничением `>=0.1.0a30,<0.2.0` (не path — чтобы в wheel попадал валидный `Requires-Dist`). Версия интерпретатора закреплена файлами `.python-version` в `packages/python` и `packages/python-host` — 3.13.18 (та же версия в CI, есть на ubuntu-latest).
- Python ≥ 3.12, pydantic 2: `ai37-capture-contract` (0.1.0).
- Общий контракт в `contract/` (JSON Schema + `feature-codes.json` + общие векторы локали и переводов карточек), кодоген `scripts/codegen.mjs`.

## Схема работы
Агент поднимается через `createAgentHost(...)` (TS) или `create_agent_host(...)` (Python). Входящий запрос проходит JWT-guard: это `AgentContext` из SDK, то есть `auth.verify` по JWKS и billing preflight (`assertExecutionAllowed`; `entitlementStatus != 'active'` → отказ, `payment_failed` → `PAYMENT_FAILED`, `no_resources` → `NO_TOKENS`). Потом вызывается `handler` агента: LLM идёт с `apiKey = llmKey` из runtime state, после успешного хода отправляется `reportUsage`. Для вызова суб-агента `a2a` форвардит тот же user-JWT (`buildA2AAuthHeaders` / `forwardAuthFetch`), relay-клиент лежит в `@ai37/agent-host/relay`.

Runtime state можно запросить с `subject` (`sub` пользователя): TS — `BillingRuntimeStateOptions { subject }` вторым аргументом `getRuntimeStateByBillingOrgId` / `getRuntimeStateByOrgId` и третьим у `assertExecutionAllowed`; Python — keyword-only `subject=` у тех же трёх методов и в протоколе `BillingClient`. Значение уходит в query `?subject=<sub>` (URL-кодируется); пустая строка — то же, что без параметра. Если billing поддерживает параметр, в ответе появляется блок `subject` (`BillingRuntimeSubject`: `userUuid`/`user_uuid`, `role` = `OWNER | EDITOR | USER | null`, `groupIds`/`group_ids`, `member`); `member: false` — `sub` не активный участник организации, тогда групп нет и `role` может быть `null`. Блок принимается и в snake_case, и в camelCase; сервер без поддержки параметра просто не присылает блок, и state разбирается как раньше. Что из роли и групп пускать — решает сам сервис. Кэш runtime state ведётся по ключу (маршрут, id, subject), поэтому два пользователя одной организации не получают роль и группы друг друга, а запросы с subject и без кэшируются раздельно; TTL прежний.

TS-хост по умолчанию работает с `legacyCompat`: запрос без заголовка `A2A-Version` (или с `0.3`) идёт через compat-слой A2A 0.3, запрос с `1.0` — в обработчик 1.x. Состояние хода (multi-turn/HITL) хранится в task store, общем для A2A и AG-UI: по умолчанию in-memory, durable-вариант — Postgres из `@ai37/agent-host/task-store`.

MCP-поверхность (`/mcp`) умеет MCP Apps: `McpToolDef.ui` кладёт в `tools/list` `_meta.ui` (`resourceUri`, `visibility`) и legacy-ключ `_meta["ui/resourceUri"]` — хосты читают оба; инструмент с `visibility: ['app']` в списке есть, прячет его хост. Ресурсы (`McpOptions.resources`, `ui://…`) отдаются через `resources/list` и `resources/read`: MIME по умолчанию `text/html;profile=mcp-app`, `_meta.ui` ресурса (`csp`, `prefersBorder`) едет и в запись списка, и в содержимое; `read` зовётся один раз на процесс, упавший не запоминается, без `resources` сервер capability `resources` не объявляет. Результат вызова несёт `structuredContent` и `_meta` как есть — поток A2UI для view едет в `_meta["ai37/a2ui"]`, а `content` понимает блоки `image`. В Python-хосте сервер `mcp` долгоживущий, поэтому кэш текста ресурсов живёт в замыкании `Server`; итог тот же — `read` раз на процесс.

Инструкции MCP-сервера задаются кодом: `McpOptions.instructions` (TS `instructions?: string`, Python `instructions: str | None`) попадают в поле `instructions` ответа `initialize` (`new McpServer(..., { instructions })` / `Server(..., instructions=…)`). Это подсказка модели на весь сервер сразу — какой инструмент брать на какой запрос. Текст видит любой авторизованный клиент `/mcp`, поэтому секреты и персональные данные туда не кладут. Не задано или пустая строка — поля в `initialize` нет, как раньше (Python приравнивает пустую строку к `None`, повторяя поведение TS SDK).

Форму во внешнем хосте (Claude, ChatGPT) собирает построитель «A2UI внутри MCP App» (`a2uiApp` / `a2ui_app`). Агент даёт чистые функции хода (`open.run`, `action.run`, `resources`) и HTML view; построитель регистрирует инструмент формы (его `ui.resourceUri` — адрес view, `readOnlyHint: true`, без `idempotentHint`), app-only инструмент действий (`visibility: ['app']`, аргументы `{name, context, state}`) и ресурс view, а `resource:<id>` разбирает в action-инструменте и отдаёт телом ресурса поверхности. Адрес view — `${viewBase}-${sha256(html)[:12]}.html` (`a2uiViewUri` / `a2ui_view_uri`), хэш одинаковый в TS и Python. У ресурса есть `uriPrefix`/`uri_prefix`: он отвечает и на прежние адреса `<prefix><хвост без '/' и ','>`, а в `resources/list` попадают только текущие адреса — хост кэширует `tools/list` и после выхода нового HTML спрашивает форму по старому. Доступ проверяется при открытии формы и перед действиями из `calcActions` (черновик, навигация и `resource:<id>` `/state` биллинга не трогают); учёт — одно событие на шаг с `calculated: true`, `skill_id` даёт агент, `total_tokens` — число или строка. Отказ биллинга — `isError` без `_meta` с понятным текстом из SDK, исключение хода — `isError` с текстом, сервер продолжает работать.

Локаль хода разрешается один раз на входе (A2A и AG-UI) функцией `resolveRequestLocale` / `resolve_request_locale`: `metadata.ai37.locale` → claim `locale` → claim `org_locale` → `ru` (последнее — обратная совместимость: клиенты, которые локаль ещё не шлют, получают прежнее поведение). Значение не обрезается до языка (`es-MX` остаётся `es-MX`) и не сводится к списку поддерживаемых: язык вне `SUPPORTED_LOCALES` (`ru`, `en`, `es`, `de`, `fr`, `pt`), например `pl`, не отвергается — LLM отвечает на нём, а детерминированные строки берутся по цепочке фолбэков до `en`. Хост кладёт локаль в `HostScope.locale`, когниция читает `currentLocale()` / `current_locale()` и добавляет секцию «Язык ответа» через `withUserLocale(system_prompt)` / `with_user_locale(system_prompt)`; relay форвардит `metadata.ai37.locale` суб-агенту (`RemoteA2aRequest.locale`). Тексты, которые хост пишет сам (`Ошибка`, `Уточните`, `Готово`, `Ошибка выполнения`), и тексты отказов billing локализованы (без локали — русский).

Персональные инструкции пользователя едут тем же конвертом: `metadata.ai37.user_instructions`. В A2A-исполнителе `parse` нормализует поле (`normalizeUserInstructions` / `normalize_user_instructions`) и кладёт в `HostScope.userInstructions` / `user_instructions`; `AgentInput.metadata.user_instructions` тоже нормализовано, пусто — поля нет. Из AG-UI `forwardedProps.ai37` поле отбрасывается: браузер — граница, значение ставит только сервер-оркестратор из своей БД (после проверки при сохранении). Когниция читает инструкции через `currentUserInstructions()` / `current_user_instructions()` и дописывает блок низшего приоритета (после правил агента и инструкции владельца) через `withUserInstructions(systemPrompt)` / `with_user_instructions(system_prompt)`; без инструкций промпт не меняется. Второй аргумент, переданный явно (даже `undefined`/`None`/`''`), scope не читает — оркестратор с пустой БД не подхватит клиентский текст из A2A-конверта. Relay форвардит `RemoteA2aRequest.userInstructions` / `user_instructions` суб-агенту рядом с `locale`; `extraMetadata.ai37` (интент скилла) это поле не затирает и не удаляет. Лимит — `USER_INSTRUCTIONS_MAX` = 1500 code points.

Карточка агента может нести переводы витрины и маршрутизации. В `showcase/v1` поле `i18n` — тег BCP-47 → `AgentShowcaseVariant` (необязательные `title`, `summary`, `computes`, `starter`, `examples` и переводы плиток `capabilities` по `id`); нормативы, `order` и гейт плитки (`skill`) не переводятся. В `routing/v1` поле `i18n` — `domains` / `excludes` на другом языке; интенты — коды и не переводятся. Нормализация приводит ключи к каноническому регистру, отбрасывает кривые ключи и пустые переводы, лимит — 16 локалей; базовые поля остаются русскими, так что потребитель без поддержки `i18n` видит прежнюю карточку. `localizeAgentShowcaseProfile` / `localize_agent_showcase_profile` собирает витрину на языке: каждое поле берётся из первого перевода по `localeVariantChain` / `locale_variant_chain` (точный тег → язык → объявленный fallback, без `en`), иначе из русской базы. `localizeAgentRoutingProfile` / `localize_agent_routing_profile` добавляет переведённые `domains` / `excludes` к русской базе, дедуплицируя фразы без учёта регистра, и никогда не убирает исключение; язык без перевода (`pl`) получает базу. В результате обеих функций нет `i18n`.

Прогресс хода публикуется в A2A-стрим нативными `status-update` со `state: working` и metadata: `ai37/node`, `ai37/reasoning`, `ai37/tool`; текст хода — append-дельтами артефакта `answer`. В Python-хосте `A2aProgress` не отбрасывает `ToolEvent`: пара `start`/`end` уходит одним завершённым вызовом `metadata['ai37/tool'] = {id, name, args, result}` — ровно в той форме, в какой его читают relay (`RemoteA2aToolCall`) и chat-backend (`TOOL_CALL_*`). Пара сопоставляется по `id`, а без него — по имени; аргументы берутся из `end`, если он их несёт, иначе из `start`; значения приводятся к JSON (даты — строкой); `start` без `end` не публикуется, а `end` без `start` публикуется без `args`/`result`. Порядок событий хода сохраняется (синхронный `emit` → очередь → async-drain).

Манифест вложений `metadata.ai37.context_files` (тип `ContextFile`) несёт необязательное поле `recognition` (`ContextFileRecognition`): итог стадии распознавания файла в пуле проекта document-service — `state` (`recognized` / `ready` / `empty` / `error` / `stopped` / `rejected`), `seriesId`, `pageCount`, `indexedPages`, `code` и `reason` отказа. `recognized` — страницы документа распознаны и читаются, но в индексе поиска документа ещё нет (индекс строится или не построился); `indexedPages` — сколько страниц текущей версии уже в индексе, поле необязательное (DS постарше его не отдаёт). Поле заполняет chat-backend в режиме `ATTACHMENT_INGEST_MODE=raw`, когда сам загрузил файлы хода в DS и дождался распознавания; агенты, не знающие поля, видят обычный манифест. В Python-хосте `parse_a2a_message` нормализует `recognition` из protobuf-`Struct` (незнакомое/промежуточное состояние читается как отсутствие поля, `pageCount`/`indexedPages`-float приводятся к int).

Второе необязательное поле манифеста — `kind` (`ContextFileKind`): чем файл был для человека, если это не обычное вложение. Пока одно значение — `voice`, запись голосового ввода композера, которую UI положил на полку чата рядом с распознанным текстом. По `mime` её не отличить (mp3 совещания, приложенный через «+», — обычный документ), поэтому вид передаётся явно. Нет поля, продюсер постарше или незнакомый вид — обычный файл: новый продюсер не ломает старого агента. Relay передаёт `kind` субагенту вместе с `mime` и `hasRaw`; в Python-хосте `parse_a2a_message` оставляет `kind='voice'` только для известного значения.

```mermaid
flowchart LR
  C[UI / оркестратор / другой агент] -->|A2A или AG-UI, Bearer user-JWT| H[agent-host]
  H -->|AgentContext: auth.verify| J[JWKS / Authentik]
  H -->|billing preflight + usage; state опционально с ?subject=<sub>| B[billing-microservice]
  B -->|state.subject: роль и группы пользователя (если запрошен subject)| R[BillingRuntimeSubject / HostScope-код агента]
  H -->|resolveRequestLocale: metadata.ai37.locale → claim locale → claim org_locale → ru| L1[HostScope.locale / current_locale]
  H -->|normalizeUserInstructions: metadata.ai37.user_instructions (только A2A; AG-UI forwardedProps отбрасывается)| U1[HostScope.userInstructions / current_user_instructions]
  H --> A[handler агента]
  A -->|apiKey = llmKey| L[LLM-шлюз]
  L1 --> A
  U1 --> A
  A -->|withUserLocale + withUserInstructions в системный промпт| L
  A -->|a2a forward user-JWT + metadata.ai37.locale + user_instructions| S[суб-агент]
  H --> T[(task store: Postgres a2a_tasks)]
  A -->|uploadToProjectPool / findProjectDocumentByTitle / listProjectPoolDocuments| D[document-service: пул проекта]
  M[MCP-клиент Claude/Cursor] -->|/mcp, Bearer user-JWT| H
  H -->|initialize: instructions; tools/list: _meta.ui + ui/resourceUri; resources/list, resources/read| V[view MCP App: ui://…]
  A -->|a2uiApp / a2ui_app: форма + action + view, resource:<id>| H
```

## Структура каталогов
- `contract/` — общий контракт: JSON Schema claims (v1.3, с `locale`/`org_locale`), billing runtime state (`billing-runtime-state.schema.json`, с необязательным блоком `subject`), A2A-расширения routing/showcase (+ векторы), схема конверта `a2a-ai37-metadata.schema.json`, общие векторы локали `locale.vectors.json` (включая `localeVariantChain`/`pickLocaleVariant`), общие векторы переводов карточек `a2a-extension-i18n.vectors.json`, `feature-codes.json`, `env.md`.
- `packages/ts/` — `@ai37/agent-sdk`: `auth`, `billing` (runtime state + `subject`, usage), `a2a` (forward, routing, showcase), `policy`, `context`, `codes`, `locale`, `testing` (фейки и фикстуры, в т.ч. `fixtures.subject`), `dev`, CLI.
- `packages/python/` — `ai37-agent-sdk`, Python-порт тех же модулей (`auth`, `billing`, `a2a`, `policy`, `locale`, `testing`, `log_redaction`); `.python-version` — 3.13.18.
- `packages/ts-host/` — `@ai37/agent-host`: A2A executor, AG-UI, MCP (MCP Apps, инструкции сервера и построитель A2UI — `mcp/types.ts`, `mcp/mcp-server.ts`, `mcp/a2ui-app.ts`, `mcp/index.ts`), relay, skills, dsh (рантайм harness-сессий), task-store, store-backend'ы и attachments, project-knowledge (пул проекта DS, service-token, мост chat-backend), host-messages, observability, `user-instructions.ts` (нормализация и блок предпочтений), CLI task store.
- `packages/python-host/` — `ai37-agent-host`, Python-порт хоста (A2A executor и `a2a_progress`, AG-UI, MCP и MCP Apps (`mcp/mcp_server.py`, `mcp/types.py`), построитель A2UI (`mcp/a2ui_app.py`), relay, store_backend, project_knowledge, `host_messages`, parse, `user_instructions.py`, Postgres/Redis task store, Langfuse); `.python-version` — 3.13.18; `[[tool.poetry.source]] ai37` (priority `supplemental`, `https://pypi.app.sp-ai.ru/simple/`).
- `packages/ts-docx/` — `@ai37/docx`: детерминированный рендер markdown → DOCX.
- `packages/capture-contract/` — `ai37-capture-contract`: модели захвата карточки товара (minstroy ↔ website-scraper).
- `scripts/` — `codegen.mjs` (contract → `codes.ts`/`codes.py`).
- `openspec/` — спецификации изменений AG-UI (action input, tool-call HITL).
- `docs/` — план миграции на приватные реестры, планы срезов (`docs/plans/…`).

## Публичные интерфейсы
- **SDK (npm/PyPI):** модули `auth`, `billing` (в т.ч. `BILLING_USER_MESSAGES`, `BILLING_USER_MESSAGES_BY_LOCALE`, `DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE`, `billingUserMessage`/`billing_user_message(reason, locale)`, `friendlyBillingMessage`/`friendly_billing_message(err, locale)`, `explainDenial`, `BillingDenialReason`), `a2a`, `context` (`AgentContext`), `codes`, `policy`, `locale`, `testing`. Subpath-экспорты TS: `.`, `./dev`, `./testing`.
- **Billing с ролью и группами пользователя (`@ai37/agent-sdk` 0.1.0-alpha.40 ↔ `ai37-agent-sdk` 0.1.0a32, AI-37/docs#749, срез S2):**
  - `BillingRuntimeSubject`: TS `{ userUuid: string; role: OrgRole | null; groupIds: string[]; member: boolean }`, Python `BillingRuntimeSubject(user_uuid, role=None, group_ids=[], member=False)`. `role` — `OWNER | EDITOR | USER | null` (`null` — не участник организации); `member: false` — `sub` не активный участник, тогда `group_ids` пуст. Тип реэкспортируется из корня обоих SDK и из `billing`.
  - Необязательное поле `BillingRuntimeState.subject` — есть, только если state запрошен с subject. Разбор принимает и snake_case (`user_uuid`, `group_ids`), и camelCase (`userUuid`, `groupIds`); отсутствие блока читается как «поля нет» (поведение как раньше). Контракт — `contract/billing-runtime-state.schema.json`.
  - Параметр `subject` (`sub` пользователя): TS `BillingRuntimeStateOptions { subject?: string }` — второй аргумент `getRuntimeStateByBillingOrgId` / `getRuntimeStateByOrgId`, третий (после `requirement`) у `assertExecutionAllowed`; Python — keyword-only `subject: str | None = None` у тех же трёх методов и в протоколе `BillingClient`. Уходит в query `?subject=<sub>` (`encodeURIComponent` / `quote`); пустая строка — то же, что без параметра; сервер без поддержки параметра просто не присылает блок.
  - Кэш runtime state — ключ (маршрут, id, subject): два пользователя одной организации не получают роль и группы друг друга, запросы с subject и без кэшируются раздельно. TTL прежний (`runtimeStateCacheTtlMs`, по умолчанию 5000; `0` — без кэша).
  - `InMemoryBillingClient`: `subjects` в конструкторе и `setSubject()` / `set_subject()`; с subject к state добавляется блок из `subjects` по `userUuid`/`user_uuid`, неизвестный пользователь получает `member: false` без групп, без subject state отдаётся как есть. Фикстуры `fixtures.subject.member()` / `fixtures.subject.not_member()` (`fixtures.subject.member()` — `EDITOR`, `member: true`, без групп; `not_member()` — `role: null`, `member: false`).
- **Модуль `locale` (TS `src/locale.ts`, Python `ai37_agent_sdk.locale`):** `SUPPORTED_LOCALES` (ru, en, es, de, fr, pt; `SupportedLocale` с `native_name` и `fallback`), `FALLBACK_LOCALE` (`en`), `LEGACY_DEFAULT_LOCALE` (`ru`), `canonicalLocaleTag`/`canonical_locale_tag`, `localeChain`/`locale_chain`, `localeVariantChain`/`locale_variant_chain` (цепочка без `en` в конце), `pickLocaleVariant`/`pick_locale_variant` (вариант из словаря `тег → значение` по этой цепочке или `undefined`/`None`), `normalizeLocale`/`normalize_locale`, `resolveRequestLocale`/`resolve_request_locale`, `t(locale, translations)`, `localeNativeName`/`locale_native_name`, `userLocaleInstruction`/`user_locale_instruction`. Общие векторы обоих реализаций — `contract/locale.vectors.json`.
- **Переводы карточек (`showcase/v1`, `routing/v1`):** необязательное `i18n` у `AgentShowcaseProfile` (`AgentShowcaseVariant`, `AgentShowcaseCapabilityVariant`) и `AgentRoutingProfile` (`AgentRoutingVariant`); функции `localizeAgentShowcaseProfile(profile, locale)` / `localize_agent_showcase_profile(profile, locale)` и `localizeAgentRoutingProfile(profile, locale)` / `localize_agent_routing_profile(profile, locale)`. URI расширений прежние, поле аддитивное; общие векторы — `contract/a2a-extension-i18n.vectors.json`.
- **CLI `ai37-agent-sdk` (TS):** dev-утилиты `devJwks`, `devBilling`, `devKey`. У Python-пакета CLI нет.
- **`@ai37/agent-host`:** subpath-экспорты `.`, `./relay`, `./skills`, `./dsh`, `./task-store`. HTTP-поверхность, которую собирает `createAgentHost`:
  - `GET /.well-known/agent-card.json` — гибридная Agent Card (поля 0.3 + `supportedInterfaces` 1.0/0.3);
  - `/a2a/v1` — A2A JSON-RPC (базовый путь настраивается через `basePath`) за JWT-guard;
  - `/agui` — AG-UI SSE за JWT-guard;
  - `/mcp` + `/.well-known/oauth-protected-resource` — опционально, при `opts.mcp` (401 + `WWW-Authenticate`); только POST (GET/DELETE → 405), stateless; с `opts.mcp.resources` — ещё `resources/list` и `resources/read`;
  - `GET /api/v1/health`, `GET /api/v1/version`, `GET /metrics` (Prometheus, вне guard).
- **MCP Apps (`@ai37/agent-host` 0.9.0 ↔ `ai37-agent-host` 0.1.0a37, спека MCP Apps 2026-01-26):**
  - `McpToolDef.ui` (`McpToolUi`: `resourceUri` + `visibility: ('model' | 'app')[]` в TS, `resource_uri` + `visibility` в Python) → в `tools/list` уходит `_meta.ui` и legacy-ключ `_meta["ui/resourceUri"]`; инструмент с `visibility: ['app']` в списке есть (прячет его хост, а не сервер).
  - `McpOptions.resources` (`McpResourceDef`: TS `uri`, `name`, `description?`, `mimeType?`, `read`, `ui?`, `uriPrefix?`; Python `uri`, `name`, `read`, `description`, `mime_type`, `ui`, `uri_prefix`) → `resources/list` и `resources/read`. MIME по умолчанию — `text/html;profile=mcp-app`; `McpResourceUi` (`csp`, `prefersBorder` / `prefers_border`) с `McpResourceCsp` (`connectDomains`/`resourceDomains`/`frameDomains`/`baseUriDomains` ↔ `connect_domains`/… ) уходит в `_meta.ui` и записи списка, и содержимого. `read` (sync или async) — один раз на процесс, упавший не запоминается; неизвестный URI — `InvalidParams`; без `resources` обработчики не регистрируются и capability `resources` не объявляется.
  - `McpResourceDef.uriPrefix` (TS) / `uri_prefix` (Python): тот же текст отдаётся и по любому адресу `<prefix><хвост без '/' и ','>`. TS регистрирует шаблон `ResourceTemplate` из `@modelcontextprotocol/sdk` (`{uriPrefix}{suffix}`, `list: undefined`), точный адрес SDK ищет раньше шаблона; Python ищет ресурс по префиксу в `_read_resource`. В `resources/list` прежние адреса не попадают.
  - `McpToolResult`: `structuredContent` / `_meta` (TS) и `structured_content` / `meta` (Python) доходят до клиента как есть; блок `{"type": "image", "data": <base64>, "mimeType": …}` в `content` уходит как `ImageContent`. `_meta` модели не показывается — это канал для view MCP App (поток A2UI кладут в `_meta["ai37/a2ui"]`); хост без UI отдаёт модели `structuredContent` вместо `content`.
  - В Python-хосте дополнительно починен `is_error` → `isError`: раньше low-level сервер всегда ставил `isError: false`.
  - Константы `MCP_APP_MIME_TYPE` (`text/html;profile=mcp-app`) и `MCP_APP_RESOURCE_URI_META_KEY` (`ui/resourceUri`); типы `McpTextContent`, `McpImageContent`, `McpToolVisibility`.
  - TS: `buildMcpServer(serverInfo, tools, ctx, resources?, instructions?)` — четвёртый и пятый необязательные аргументы; низкоуровневые примитивы (`buildMcpServer`, `protectedResourceMetadataRouter`, …) экспортируются из корня.
  - **BREAKING только по типам:** `McpToolResult.content` — `Array<McpTextContent | McpImageContent>` (TS) / `list[McpTextContent | McpImageContent]` (Python) вместо чисто текстового списка; в рантайме это те же словари/объекты.
  - Python: для MCP Apps нужен `mcp` ≥ 1.27 (раньше `ReadResourceContents` не нёс `meta`); `mcp` подгружается лениво — без пакета `build_mcp_server`/`create_mcp_asgi_app`/`mount_mcp` бросают `MissingMcpDependencyError`.
- **Инструкции MCP-сервера (`@ai37/agent-host` 0.10.0 ↔ `ai37-agent-host` 0.1.0a38):**
  - `McpOptions.instructions?: string` (TS) / `McpOptions.instructions: str | None = None` (Python) → поле `instructions` в ответе `initialize` (`new McpServer(info, { instructions })`, `Server(name, version=…, instructions=…)`). Текст — подсказка модели на весь сервер: какой инструмент брать на какой запрос; виден любому авторизованному клиенту `/mcp`, поэтому без секретов и персональных данных; строка одна на сервер, не на пользователя.
  - Не задано или пустая строка — поля `instructions` в `initialize` нет, поведение как раньше (Python приравнивает пустую строку к `None`).
  - TS: `buildMcpServer(serverInfo, tools, ctx, resources?, instructions?)` — пятый необязательный аргумент; `mcpHttpHandler` прокидывает `opts.instructions`. В Python-хосте сигнатура `build_mcp_server(server_info, opts)` не менялась — инструкции берутся из `opts`.
- **Построитель «A2UI внутри MCP App» (`@ai37/agent-host` 0.12.0 ↔ `ai37-agent-host` 0.1.0a40):**
  - TS: `a2uiApp(opts)` (async) → `A2uiApp { tools, resources, viewUri, billing }`; `A2uiAppOptions`: `viewBase`, `html`, `surfaceId`, `viewName?`, `open { name, title, description, inputSchema: ZodRawShape, run(args, ctx) }`, `action { name, title, description, run(name, context, state, ctx) }`, `resources?` (`resource:<id>` → тело), `billing: A2uiAppBilling`, `calcActions: string[]`.
  - Python: `a2ui_app(*, view_base, html, surface_id, open: A2uiAppTool, action: A2uiAppTool, billing: A2uiAppBilling, calc_actions, resources=None, view_name=None)` → `A2uiApp(tools, resources, view_uri, billing)`; `A2uiAppTool(name, title, description, run, input_schema=None)` — `run` формы `(args, ctx)`, действий `(name, context, state, ctx)`, sync или async.
  - `A2uiStep`: `text` (текст для модели и хоста без UI), `state` (данные документа), `calculated` (единственный учитываемый ход), `node?` (`{component, props}` — нет у черновика), `report?`.
  - `a2uiViewUri(viewBase, html)` / `a2ui_view_uri(view_base, html)` = `${viewBase}-${sha256(html)[:12]}.html` — хэш одинаковый в TS и Python (`a2ui_view_uri('ui://x/a2ui-surface', 'абв')` = `ui://x/a2ui-surface-39e305d37ff4.html`).
  - `mcpBilling(billing)` / `mcp_billing(billing)` → `McpBilling { check(ctx), meter(ctx, skillId) }` — та же проверка и учёт для структурных MCP-инструментов агента.
  - `A2uiAppBilling`: `enabled`, `requirement` (`BillingExecutionRequirement`), `metricCode`/`metric_code`, `skillId`/`skill_id` (функция шага → `skill_id` события), `minTokens`/`min_tokens` (по умолчанию 0), `totalTokens`/`total_tokens` (`number | string` / `int | str`, как агент шлёт его в A2A-пути).
  - Регистрируемые инструменты: форма (`ui.resourceUri` = view, `readOnlyHint: true`, без `idempotentHint` — повтор расчёта даёт новое событие) и app-only действие (`visibility: ['app']`, аргументы `{name, context, state}`). `resource:<id>` разбирается (`parseResourceActionName` / `parse_resource_action_name`) и отдаётся через `a2uiResourceResult`; исключение чтения — пустое тело.
  - Биллинг: проверка при открытии формы и перед `calcActions`; учёт — одно событие на `calculated: true` через `reportUsage`/`report_usage`; отказ — `isError` без `_meta` и с текстом из SDK (`friendlyBillingMessage`, `billingUserMessage('NO_TOKENS')`, `DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE` при отсутствии контекста); `enabled: false` — ни проверки, ни учёта; сбой учёта не ломает ответ.
  - Ресурс view: `read` отдаёт HTML, `_meta.ui = { prefersBorder: true }`, `uriPrefix`/`uri_prefix` = `viewBase`; в `resources/list` только текущий адрес.
  - `@ai37/a2ui-mcp-app` (≥ 0.50.0) — optional peer, подгружается динамически: без него `a2uiApp` бросает ошибку с подсказкой `npm i @ai37/a2ui-mcp-app`. В Python — extra `a2ui` (`ai37-a2ui-catalog` ≥ 0.50.0, Python ≥ 3.13), тоже ленивый импорт.
- **Персональные инструкции пользователя (`@ai37/agent-host` 0.11.0 ↔ `ai37-agent-host` 0.1.0a39, план AI-37/docs#740):**
  - `Ai37Metadata.user_instructions` (TS `?: string`, Python `str | None`) — поле конверта `metadata.ai37.user_instructions`. Ставит только оркестратор — из своей БД, после проверки при сохранении; relay форвардит. Хост читает его только из A2A-метаданных, нормализует (`normalizeUserInstructions` / `normalize_user_instructions`) и кладёт в `HostScope.userInstructions` / `user_instructions`; `AgentInput.metadata.user_instructions` тоже нормализовано, пусто — поля нет. AG-UI-роутер поле из `forwardedProps.ai37` отбрасывает: браузер — граница.
  - `USER_INSTRUCTIONS_MAX = 1500`, `normalizeUserInstructions(raw)` / `normalize_user_instructions(raw)`: NFC; `\r\n` и одиночный `\r` → `\n`; без управляющих символов (кроме `\n`, `\t`), zero-width и bidi; без пробелов в конце строк; не больше одной пустой строки подряд; trim; обрезка до 1500 code points без разрыва суррогатных пар (TS). Пусто или не строка → `undefined` / `None`. Идемпотентна.
  - `userInstructionsBlock(text)` / `user_instructions_block(text)` — блок «## Предпочтения пользователя (стиль и формат ответа)» с текстом в `<user_preferences>`; тег-обёртка внутри текста экранируется в любом регистре и с пробелами (`</ User_Preferences >`), чтобы пользователь не закрыл блок раньше времени. Пусто → `''`. Тексты TS и Python совпадают байт-в-байт (общий golden-блок и SHA-256 в тестах обоих пакетов).
  - `currentUserInstructions()` / `current_user_instructions()` — инструкции текущего хода (нормализованные) или `undefined`/`None`; `withUserInstructions(systemPrompt, text?)` / `with_user_instructions(system_prompt, text=...)` — дописывают блок в конец системного промпта, низший приоритет (после правил агента и инструкции владельца), как `withUserLocale`; без инструкций промпт не меняется. Без второго аргумента берутся инструкции хода; явный аргумент, даже `undefined`/`None`/`''`, scope не читает — оркестратор с пустой БД не подхватит клиентский текст из A2A-конверта.
  - `RemoteA2aRequest.userInstructions` / `user_instructions` → `metadata.ai37.user_instructions` (после нормализации, рядом с `locale`); `extraMetadata.ai37` (интент скилла) это поле не затирает и не удаляет; пусто — поля нет и конверта без других полей не будет.
- **Модуль project-knowledge (`@ai37/agent-host`, реэкспорт из корня):** `uploadToProjectPool`, `findProjectDocumentByTitle`, `listProjectPoolDocuments` (+ константа `MAX_SERIES_IDS` = 50), `serviceToken`, `indexToProject`, `ProjectPoolError` (несёт `code`, `status`, `retryAfterSeconds`, `cause`), `ProjectKnowledgeError`, `ServiceTokenError`, `ProjectPoolDocument`, `ProjectPoolDocumentState`, `ListProjectPoolDocumentsOptions`. `uploadToProjectPool` шлёт тело без multipart (`X-File-Name`, `X-Project-Name`); `Content-Length` ставится руками только для потока (`{ stream, size }`, уходит полудуплексом), у `Uint8Array`/`Blob` длину проставляет сам fetch. `listProjectPoolDocuments({ documentServiceUrl, projectKey, seriesIds, bearer })` читает `GET /api/project-pools/{key}/documents?seriesIds=…` и возвращает строки реестра (`state`, `pageCount`, `readyPages`, `indexedPages`) только для запрошенных серий: пустой список — пустой ответ без запроса, больше 50 серий — `ProjectPoolError('invalid_query')` без запроса, строки чужих пулов отбрасываются. `ProjectPoolDocumentState` = `queued | processing | recognized | ready | empty | error | stopped`; `ProjectPoolDocument.indexedPages` — необязательное число (нет у DS постарше).
- **Типы манифеста:** `ContextFile` с необязательными `recognition?: ContextFileRecognition` и `kind?: ContextFileKind`; `ContextFileKind = 'voice'` (вид вложения: голосовая запись композера); `ContextFileRecognitionState` = `recognized | ready | empty | error | stopped | rejected`; `ContextFileRecognition.indexedPages?` — сколько страниц уже в поиске (у `ready` равно `pageCount`); все три типа реэкспортируются из `.` и `./relay`.
- **Типы конверта:** `Ai37Metadata` с необязательными `locale` (тег BCP-47, как пришёл; у Python — `locale: str | None`) и `user_instructions` (персональные инструкции пользователя, нормализованные); `Claims` с необязательными `locale` и `org_locale`.
- **CLI `ai37-agent-host-task-store`:** `migrate | check | cleanup` для таблицы `a2a_tasks` (строка подключения из `DATABASE_URL`).
- **`ai37-agent-host` (Python):** та же поверхность (`/api/v1/health`, `/api/v1/version`, `/.well-known/agent-card.json`, `/a2a/v1`, `/agui`, `/mcp`, `/metrics`); из корня экспортируются `ContextFile`, `ContextFileKind`, `ContextFileRecognition` (`state`, `series_id`, `page_count`, `indexed_pages`, `code`, `reason`), `ContextFileRecognitionState` (включая `recognized`), `Ai37Metadata`, project_knowledge (`upload_to_project_pool`, `find_project_document_by_title`, `service_token`, `index_to_project`), `current_locale`, `with_user_locale`, `current_user_instructions`, `with_user_instructions`, `USER_INSTRUCTIONS_MAX`, `normalize_user_instructions`, `user_instructions_block`. `ProjectPoolDocument` в Python несёт `indexed_pages: int | None` (`None` — DS постарше поле не отдаёт), состояние `recognized` приходит в `state` как есть. MCP Apps-типы и построитель A2UI (`a2ui_app`, `a2ui_view_uri`, `mcp_billing`, `A2uiApp`, `A2uiAppTool`, `A2uiStep`, `A2uiAppBilling`, `McpBilling`) реэкспортируются из `ai37_agent_host.mcp`.
- **Локаль в Python-хосте:** `HostScope.locale` (кладёт executor на A2A и AG-UI-роутер), `current_locale()` (вне хода и на MCP-пути — из claims, иначе `ru`), `with_user_locale(system_prompt, locale=None)` (дописывает секцию «Язык ответа», промпт остаётся на русском), `host_message(key)` из `ai37_agent_host.host_messages` для ключей `failed | input_required | tool_failed | done`, `RemoteA2aRequest.locale` → `metadata.ai37.locale` (при этом `extra_metadata['ai37']` сливается с собранным конвертом, а не заменяет его).
- **A2A-прогресс Python-хоста (`A2aProgress`):** `node`/`reasoning` → `status-update working` с metadata `ai37/node` / `ai37/reasoning`; `ToolEvent` (`phase = start | end`, `id?`, `name`, `args?`, `result?`) → один `status-update working` с `metadata['ai37/tool'] = {id, name, args, result}` на `end` (JSON-совместимые значения, `id` генерируется, если его не было); пауза тишины `A2A_KEEPALIVE_S = 20` даёт keepalive-`working` без metadata.
- **`@ai37/docx`:** `renderMarkdownToDocx(markdown)`.

## Зависимости в экосистеме
### Зависит от
- Authentik (OIDC issuer/JWKS) — проверка user-JWT; claims `locale`/`org_locale` приходят из профиля/группы организации.
- billing-microservice — runtime state (`llmKey`, `entitlementStatus`, опционально блок `subject` с ролью и группами пользователя при запросе с `?subject=<sub>`), preflight, usage (в т.ч. события построителя A2UI: одно на `calculated`-шаг).
- LLM-шлюз (LiteLLM) — через `llmKey` из runtime state.
- Суб-агенты по A2A — forward user-JWT, `metadata.ai37.locale` и `metadata.ai37.user_instructions`.
- document-service (DS) — пул проекта: загрузка файла, поиск документа по названию, чтение реестра документов по `seriesIds` (состояния и счётчики страниц, в т.ч. `recognized` / `indexedPages`); organization берётся из токена/пула.
- chat-backend — мост «добавить в базу проекта» (`indexToProject`), артефакты тредов/проектов, чтение файлов хода; оркестратор ставит `user_instructions` из своей БД.
- `ai37-agent-sdk` (Python) `>=0.1.0a30,<0.2.0` — версионное ограничение `ai37-agent-host` (не path, чтобы в wheel был валидный `Requires-Dist`); в CI поверх опубликованной версии ставится сиблинг из этого же коммита. `@ai37/agent-host` — peer `@ai37/agent-sdk` ≥ 0.1.0-alpha.38.
- Postgres — durable task store и LangGraph-чекпоинтер в host-слое; Redis — опциональный `RedisTaskStore` в Python-хосте.
- `@ai37/a2ui-catalog-schemas` ^0.10.0 — зависимость `@ai37/agent-host`.
- `@ai37/a2ui-mcp-app` ≥ 0.50.0 (TS, optional peer, динамический импорт) и `ai37-a2ui-catalog` ≥ 0.50.0 (Python, extra `a2ui`, Python ≥ 3.13, ленивый импорт) — помощники протокола A2UI для построителя формы во внешнем MCP-хосте; `@ai37/a2ui-mcp-app` тянет `@ai37/a2ui-catalog-schemas` ^0.50.0.
- `@modelcontextprotocol/sdk` (TS, optional peer ≥ 1.26.0) и python `mcp` (≥ 1.27, dev-группа; в рантайме soft-import) — MCP-поверхность, MCP Apps, инструкции сервера в `initialize` и шаблон `ResourceTemplate` для `uriPrefix`.
- Langfuse — опциональная трассировка ходов.
- Приватные реестры: Verdaccio `npm.app.sp-ai.ru` (токен `AI37_NPM_TOKEN`), PyPI `pypi.app.sp-ai.ru` (источник `ai37`, priority `supplemental`; креды `POETRY_HTTP_BASIC_AI37_USERNAME`/`POETRY_HTTP_BASIC_AI37_PASSWORD`).

### От него зависят
- spai-chat-backend и его форки (оркестратор на `@ai37/agent-host`; читает `ai37/tool` из A2A-стрима как `TOOL_CALL_*`; передаёт `user_instructions` в конверте).
- search-agent и форки `{spai,pdai,graphema}-search-agent`.
- spai-elevator-calc-agent, spai-thermal-calc-agent, spai-daylight-factor-calc-agent, spai-consultant-agent; агенты лифтов, КЕО и теплотеха — первые потребители построителя `a2uiApp` / `a2ui_app` (общая обвязка формы во внешнем хосте переехала в host-слой из агента лифтов).
- pdai-doc-gen-agent, pdai-site-check, polimetrika-data-agent (`ai37-agent-host`), minstroy (`ai37-agent-sdk` + `ai37-agent-host`).
- document-service и форки, spai-ui (по components.md).
- minstroy и website-scraper — потребители `ai37-capture-contract`.

## Конфигурация
Единые имена переменных (`contract/env.md`):
- `AI37_OIDC_ISSUER`, `AI37_OIDC_JWKS_URL`, `AI37_OIDC_AUDIENCE` — проверка JWT; `AI37_AUTH_REQUIRED` — обязательность JWT.
- `AI37_AUTH_MODE` (`jwks` | `insecure-dev`), `AI37_DEV_CLAIMS_FILE` — dev-обход подписи (запрещён при прод-признаках).
- `BILLING_MICROSERVICE_BASE_URL`, `BILLING_MODE` (`http` | `fake`), `BILLING_IDENTITY_SOURCE`, `LLM_KEY_SOURCE`.
- `A2A_AUTH_MODE` — `forward-user-jwt`.
- Host-слой: `DATABASE_URL`, `TASK_STORE_EXTERNAL_SCHEMA` (CLI task store); `LITELLM_BASE_URL` (`LITELLM_BASE_URL_ENV`); `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`/`LANGFUSE_BASE_URL`, `LANGFUSE_TRACING_ENABLED`, `LANGFUSE_CAPTURE_CONTENT`, `LANGFUSE_TRACING_ENVIRONMENT`, `LANGFUSE_RELEASE`; `CHAT_BACKEND_URL`, `SERVICE_CLIENT_ID`, `SERVICE_CLIENT_SECRET` (project-knowledge); `ATTACHMENT_INGEST_MODE` (у продюсера chat-backend: `raw` включает заполнение `ContextFile.recognition`).
- `AI37_NPM_TOKEN` — токен приватного npm для сборки `packages/ts-host` (в т.ч. для `@ai37/a2ui-mcp-app`).
- `POETRY_HTTP_BASIC_AI37_USERNAME` / `POETRY_HTTP_BASIC_AI37_PASSWORD` — креды приватного Python-индекса `ai37` (`https://pypi.app.sp-ai.ru/simple/`), нужны для `poetry install` в `packages/python-host` (SDK, `ai37-a2ui-catalog` и прочие `ai37-*` лежат только там). В CI — `ci-read` и секрет `AI37_PYPI_TOKEN` (как в `publish-python-host.yml`), локально — из окружения.
- `llmKey` берётся только из runtime state billing, не из env и не из JWT.
- `subject` для runtime state собственной env-переменной не имеет: это параметр вызова (`{ subject }` в TS, `subject=` в Python), уходит в query `?subject=<sub>`. Роль и группы возвращаются в самом state (`BillingRuntimeState.subject`), TTL кэша — код (`runtimeStateCacheTtlMs`, по умолчанию 5000).
- Локаль хода собственной env-переменной не имеет: разрешается из `metadata.ai37.locale` → claim `locale` → claim `org_locale` → `ru` (код `resolve_request_locale`; claims — из user-JWT, `contract/claims.schema.json` v1.3).
- Персональные инструкции пользователя тоже без env-переменной: приходят в `metadata.ai37.user_instructions` из A2A-конверта (ставит оркестратор); лимит `USER_INSTRUCTIONS_MAX` = 1500 — константа кода.
- Переводы карточек (`showcase/v1`, `routing/v1`) задаются в самой Agent Card полем `i18n`; отдельной env-переменной нет.
- MCP Apps настраивается кодом (`opts.mcp.resources`, `McpToolDef.ui`), env-переменных нет. Инструкции MCP-сервера — тоже код (`opts.mcp.instructions`), отдельной env-переменной нет. Построитель A2UI настраивается только кодом (`a2uiApp(opts)` / `a2ui_app(...)`: `viewBase`, `html`, `surfaceId`, `open`, `action`, `billing`, `calcActions`, `resources`) — env-переменных нет; для Python нужен extra `a2ui` (`pip install 'ai37-agent-host[a2ui]'`, Python ≥ 3.13), для TS — пакет `@ai37/a2ui-mcp-app`.

## Данные и хранилища
- У SDK нет собственной БД.
- Кэш runtime state в SDK — in-process: в TS `LRUCache` (`max: 10_000`, TTL `runtimeStateCacheTtlMs`), в Python `dict` с монотонным временем; ключ — (маршрут, id, subject), поэтому два пользователя одной организации не получают роль и группы друг друга, а запрос с subject и без него кэшируются раздельно. На диск ничего не пишется, блок `subject` живёт в памяти процесса вместе с остальным state.
- `@ai37/agent-host/task-store` — Postgres-таблица `a2a_tasks`: схему создаёт `ai37-agent-host-task-store migrate` (через `a2a-db upgrade`). Если её ведёт сам сервис, ставится `TASK_STORE_EXTERNAL_SCHEMA=true`. Ретенция — `cleanup` (`--terminal-days 7`, `--stale-days 14` по умолчанию).
- Python-хост: `PostgresTaskStore` (extra `postgres`) и `RedisTaskStore` (extra `redis`).
- Пул проекта DS — внешнее хранилище document-service; SDK/хост только читают и пишут через HTTP (`/api/project-pools/{key}/documents`), своей схемы не создают.
- MCP Apps собственного хранилища не вводит: HTML-view приезжает в образ зависимостью, текст ресурса кэшируется в памяти процесса (в TS — `WeakMap` по определению ресурса, в Python — замыкание долгоживущего `Server`). Инструкции MCP-сервера — статическая строка в конфиге хоста, не хранилище.
- Построитель A2UI своего хранилища не вводит: HTML view приходит параметром `html`, отдаётся ресурсом view через тот же кэш текста; состояние документа формы (`A2uiStep.state`) живёт на клиенте view и приезжает в следующем действии; события учёта уходят в billing-microservice.
- Персональные инструкции пользователя хост не хранит: значение приходит на ходе из A2A-конверта, живёт в request-scope (`HostScope`) и уходит в промпт/relay; хранилище — БД оркестратора, не этого репозитория.

## Быстрый старт (локально)
Библиотеки, отдельного сервиса нет. Разработка — через корневой Makefile:
```bash
make codegen           # contract/feature-codes.json → codes.ts + codes.py
make ts                # @ai37/agent-sdk: npm ci + lint + test + build
make ts-docx           # @ai37/docx
make py                # ai37-agent-sdk: poetry install --with dev + ruff + mypy + pytest
make capture-contract  # ai37-capture-contract
```
Для `@ai37/agent-host` (`packages/ts-host`) нужен собранный `packages/ts` и токен приватного npm (`AI37_NPM_TOKEN`, корневой `.npmrc`): `npm ci && npm run verify`. Python-хост проверяется против SDK из того же рабочего дерева: после `poetry install --with dev` в `packages/python-host` ставится `poetry run pip install --no-deps ../python` (так делает CI; отдельного шага в Makefile нет). `poetry install --with dev` там же ставит `mcp` (≥ 1.27) и `ai37-a2ui-catalog` (≥ 0.50.0) — ими гоняются тесты MCP-поверхности, MCP Apps, инструкций сервера и построителя A2UI; в рантайме оба не обязательны (soft-import, для A2UI — extra `a2ui`). Для самого `poetry install` в `packages/python-host` нужны креды приватного индекса `ai37` — `POETRY_HTTP_BASIC_AI37_USERNAME` / `POETRY_HTTP_BASIC_AI37_PASSWORD` (источник объявлен в `pyproject.toml`, priority `supplemental`: публичный PyPI первым, `ai37` — fallback).

## Как запускать тесты
```bash
make verify   # codegen-парити + ts + ts-docx + py + capture-contract
```
По пакетам: `npm test` (`vitest run`) в `packages/ts`, `packages/ts-host`, `packages/ts-docx`; `poetry run pytest` в `packages/python`, `packages/python-host`, `packages/capture-contract`. Полный гейт `packages/ts-host` — `npm run verify` (lint + format + test + build + `test:package`).

Блок `subject` в runtime state — `packages/ts/test/billing.test.ts` (группа `subject`) и `packages/python/tests/test_billing.py`: два пользователя одной организации получают каждый свои группы из кэша; запросы с subject и без кэшируются раздельно; `subject` уходит в query URL-кодированным на обоих маршрутах (`by-org` и `by-billing-org`); пустая строка = без параметра; блок разбирается и в snake_case, и в camelCase, не-участник (`member: false`) читается корректно; state без блока разбирается как раньше; `assertExecutionAllowed` форвардит subject; `InMemoryBillingClient` отдаёт subject по пользователю (неизвестный — `member: false` без групп) и без subject — state как есть.

Локаль проверяется общими векторами `contract/locale.vectors.json` с обеих сторон: `packages/ts/test/locale.test.ts` и `packages/python/tests/test_locale.py` (канонизация тега, `localeChain`/`localeVariantChain`, `pickLocaleVariant`, `normalize_locale`, `resolve_request_locale`, точный текст инструкции и billing-сообщений); переводы карточек — `contract/a2a-extension-i18n.vectors.json` в `packages/ts/test/extension-i18n.test.ts` и `packages/python/tests/test_extension_i18n.py`; паритет хостов — `packages/ts-host/test/locale.test.ts` и `packages/python-host/tests/test_locale.py`.

MCP Apps проверяются настоящим клиентом MCP SDK поверх in-memory транспорта: `packages/ts-host/test/mcp-apps.test.ts` и `packages/python-host/tests/test_mcp_apps.py` (в Python — `create_connected_server_and_client_session`; в `test_mcp_server.py`/`test_mcp_mount.py` отсутствие пакета `mcp` изображается подменой `sys.modules`). Инструкции MCP-сервера — `packages/ts-host/test/mcp-instructions.test.ts` (в т.ч. через HTTP `POST /mcp`) и `packages/python-host/tests/test_mcp_instructions.py` (ответ `initialize` как он идёт по проводу; `test:package`-паритет по тестам).

Построитель A2UI — `packages/ts-host/test/a2ui-app.test.ts` и `packages/python-host/tests/test_a2ui_app.py`: настоящий клиент MCP SDK поверх сервера хоста (`InMemoryTransport` / `create_connected_server_and_client_session`), `_meta.ui` инструментов и видимость app-only действия, адрес view с хэшем HTML (одинаковый в TS и Python), чтение view по текущему и прежним адресам при `resources/list` только с текущим, `resource:<id>`, проверка доступа при открытии и перед `calcActions`, одно событие учёта на `calculated`-шаг с `skill_id` и `total_tokens` (число или строка), отказы биллинга (`isError` без `_meta`, понятный текст), `enabled: false`, сбой учёта и исключение хода.

Персональные инструкции пользователя — `packages/ts-host/test/user-instructions.test.ts` и `packages/python-host/tests/test_user_instructions.py`: нормализация (NFC, управляющие/zero-width/bidi, переводы строк, лимит 1500 code points, идемпотентность), golden-блок с общим SHA-256 (`e5b8aee4…`), экранирование тега-обёртки, `withUserInstructions`/`with_user_instructions` (явный `undefined`/`None` не читает scope), разбор A2A-конверта в scope (через настоящий хост и relay), игнор `forwardedProps.ai37` на AG-UI и форвард `RemoteA2aRequest.userInstructions` рядом с `locale`/интентом.

Postgres-тесты task store (`test/task-store.pg.test.ts`, `tests/test_postgres_task_store.py`) требуют живой Postgres; в CI это `postgres:18-alpine` (переменные `TEST_DATABASE_URL`, `REQUIRE_TEST_DATABASE=1` для ts-host). В ts-host эти тесты поднимают таймаут до 20 с на тест и хук: каждый тест создаёт и удаляет свою временную базу, на загруженном раннере это дольше дефолтных 5 с.

## Деплой
Не деплоится, публикуется как библиотеки. CI `ci.yml` — одна джоба `ci-green` на PR, проверяет все пакеты по очереди; Python-пакеты гоняются на закреплённом интерпретаторе 3.13.18 (`.python-version` в `packages/python` и `packages/python-host`; на ubuntu-latest он доступен). Python-хост в CI ставит поверх опубликованного SDK сиблинг из этого же коммита (`poetry run pip install --no-deps ../python`) — как ts-host берёт `file:../ts`; установка зависимостей python-host идёт с кредами приватного индекса `ai37` (`POETRY_HTTP_BASIC_AI37_USERNAME=ci-read`, `POETRY_HTTP_BASIC_AI37_PASSWORD` из секрета `AI37_PYPI_TOKEN`), потому что SDK и `ai37-a2ui-catalog` в локе тянутся из `pypi.app.sp-ai.ru`. Публикация (`publish-python-host.yml`) сиблинг не ставит, поэтому хост с неопубликованным SDK в индекс не уходит. Публикация — workflow'ы `publish-ts.yml`, `publish-ts-host.yml`, `publish-ts-docx.yml` (npm → `https://npm.app.sp-ai.ru/`) и `publish-python.yml`, `publish-python-host.yml`, `publish-capture-contract.yml` (twine → `https://pypi.app.sp-ai.ru/`), у каждого есть режим `dry_run`. Helm/terraform нет.

## Связанные документы
- `ecosystem/v2/09-agent-runtime.md` — рантайм агентов и SDK.
- `ecosystem/v2.4/06-i18n-locale.md` — локаль пользователя: конверт `metadata.ai37.locale`, `SUPPORTED_LOCALES`, цепочка фолбэков, инструкция LLM.
- `ecosystem/v2/02-authentication.md`, `ecosystem/v2/03-billing.md`, `ecosystem/v2/04-a2a-conventions.md` (конверт `metadata.ai37`), `ecosystem/v2/10-agui-protocol.md`.
- `ecosystem/v2.2/02-agent-host-unification.md` — `@ai37/agent-host`.
- `ecosystem/v2.2/04-state-storage-postgres.md`, `ecosystem/v2.4/02-postgres-only-state-and-queues.md` — Postgres task store.
- `ecosystem/v2.4/03-mcp-surfaces.md`, `ecosystem/v5/02-oauth-for-mcp.md` — MCP-поверхность хоста.
- `ecosystem/v5/03-tool-contract.md` — контракт инструментов MCP (заголовок в `title` и `annotations.title`, §6).
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
| `ai37-capture-contract` | PyPI | `packages/capture-contract` | контракт захвата карточки товара для рендереров мониторинга цен (minstroy ↔ website-scraper) |

> `ai37-capture-contract` — доменный пакет, не слой SDK: он описывает контракт захвата карточки
> товара между minstroy и headed-рендерером `website-scraper`. Живёт здесь по тому же основанию,
> что `@ai37/docx`: общий для нескольких репозиториев код публикуется из монорепо с публикационными
> секретами, а не path-зависимостью одного потребителя (решение разработчика 07.10.2026,
> план AI-37/docs#445 §3.4). На `contract/`, кодоген и публичный API SDK не влияет.

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
make ts-docx     # локальный markdown → DOCX рендерер @ai37/docx
make py          # сборка/тесты Python-пакета (Python 3.11+ / poetry)
make capture-contract  # линт/типы/тесты ai37-capture-contract (Python 3.12+ / poetry)
make verify      # codegen-парити + TS/Python SDK + @ai37/docx + ai37-capture-contract
```

Статус: **0.1.0-alpha**.
