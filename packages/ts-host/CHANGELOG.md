# Changelog — @ai37/agent-host

Формат: [Keep a Changelog](https://keepachangelog.com/). Версия — `package.json` этого пакета;
публикуется независимо от `@ai37/agent-sdk` (от которого зависит как peer).

## [0.1.0-alpha.40]

### Added
- **Шов durable-чекпоинтера на уровне хоста.** Новое опциональное поле `AgentHostOptions.checkpointer`
  (`BaseCheckpointSaver`): host кладёт saver в turn-scope, а когниция агента забирает его через новый
  `currentCheckpointer()` и цепляет в свой граф (`graph.compile({ checkpointer })` / deepagents). Это
  ДРУГОЙ уровень состояния, чем A2A `taskStore` (тот держит состояние хода/HITL в `task.metadata`);
  checkpointer — durable графовое состояние LangGraph по `thread_id`. Не задан → `currentCheckpointer()`
  вернёт `undefined` (агент строит граф без durable-состояния). Аддитивно: дефолтное поведение не
  меняется. Зеркально в `ai37-agent-host` (Python): `create_agent_host(checkpointer=...)` +
  `current_checkpointer()`.
- **Фабрика `createCheckpointer({ databaseUrl })`.** `databaseUrl` задан → `PostgresSaver.fromConnString`
  + `setup()` (durable, переживает рестарт/мульти-под); иначе → `MemorySaver` (dev). Пакеты
  `@langchain/langgraph-checkpoint*` — **optional peers** и импортируются **лениво** (dynamic import),
  поэтому обычный `import '@ai37/agent-host'` их не требует: ставит их только агент, реально зовущий
  `createCheckpointer`. Ретенция старых тредов — вне пакета (k8s CronJob в `agent-template-js`).

## [0.1.0-alpha.39]

### Added
- **Генерик-механизм скиллов агента** — subpath-экспорт `@ai37/agent-host/skills` (loader/registry/
  dispatch/compose-card). Запись добавлена задним числом при merge (PR #62 забампил версию без записи).

## [0.1.0-alpha.38]

### Changed
- **Содержимое хода больше не пишется в трассировку по умолчанию.** `withTurnObservability` клал в
  turn-спан `input: { text }` — сырой текст пользователя — и `output: { message }`, где `message` у
  доменных агентов равен целиком сгенерированному документу. Спан привязан к `userId` и `sessionId`,
  то есть содержимое становилось профилируемым по конкретному человеку и уезжало туда, где развёрнут
  Langfuse (в примерах платформы по умолчанию предлагается SaaS вне РФ).

  Теперь по умолчанию в спан идут `input: { textLen }` и `output: { status, messageLen }`;
  `payloadMode` в метаданной честно помечается как `redacted`. Идентификаторы, статусы, тайминги,
  `sessionId`/`userId` и токены сохраняются — структура трейса не страдает.

  Вернуть прежнее поведение: `LANGFUSE_CAPTURE_CONTENT=true`. Включать осознанно — там, где Langfuse
  стоит в своём контуре и обработка содержимого хода имеет правовое основание.

### Added
- **Маска процессора при выключенном захвате содержимого.** `LangfuseSpanProcessor` получает
  `mask`, которая применяется ко всем спанам перед экспортом — включая те, что строит
  `@langfuse/langchain` (промпты и ответы модели): их хост не создаёт и иначе не контролирует.
  Служебная метаданная `trace.v1` пропускается по маркеру `schemaVersion` — Langfuse применяет маску
  и к metadata, поэтому без явного пропуска трейс потерял бы `turnId`, статус, канал и тенант.
  Токены и тайминги не затрагиваются: они лежат в отдельных атрибутах `gen_ai.usage.*`.
- Публичные хелперы `isLangfuseContentCaptured`, `langfuseContentMask`, `turnTracePayload`,
  `turnOutputPayload` — чтобы правило проверялось тестом, а не соглашением.

## [0.1.0-alpha.37]

### Added
- **`rerun_last_turn` в конверте `metadata.ai37`.** Опциональный булев флаг: клиент перепрогоняет
  последний ход треда, а не задаёт новый вопрос. Читает его оркестратор (откат хвоста хода, чтобы
  вопрос не задвоился); вниз сабагентам не форвардится. Аддитивно — старые клиенты и агенты не
  затронуты. Рантайм `extractAi37` не менялся: конверт и так проходит сквозным спредом.

## [0.1.0-alpha.35]

### Fixed
- **Trace carrier теперь сохраняет baggage.** Входящий A2A `message.metadata` больше не теряет
  `baggage` при парсинге trace-контекста, поэтому distributed Langfuse trace сохраняет полный carrier
  между hop'ами.

## [0.1.0-alpha.34]

### Changed
- **Имена turn-спанов в Langfuse.** Вместо обезличенных `agui-turn` / `a2a-turn` —
  `{service}:agui` / `{service}:a2a`, где `service` — slug из `card.name` (как в Prometheus).
  В списке трейсов сразу видно источник: `sp-ai-orchestrator:agui`, `lift-calculation-agent:a2a`.

### Fixed
- **`trace.v1` correlation без legacy-подмен.** `withTurnObservability` кладёт в ALS
  `sessionId=contextId`, `turnId=taskId`. `withRemoteA2aObservability` читает их оттуда и пишет
  тот же envelope; OTel `traceId` — отдельное поле (дерево клеит W3C `traceparent`).
  Fallback `sessionId/turnId = traceId|agentId` убран: вне turn-scope remote-спан открывается,
  но fake correlation не пишется.

## [0.1.0-alpha.33]

### Added
- Stable `trace.v1` metadata envelope for turn, planner, agent, generation and tool observations.
- Consistent status and correlation fields for distributed A2A traces.

## [0.1.0-alpha.30] - 2026-07-27

### Added
- **Prometheus-метрики хоста (`GET /metrics`).** Общий `createAgentHost` экспонирует низкокардинальные
  `ai37_*`-серии — все агенты и оркестратор получают RED + billing/auth-сигналы без своего кода:
  `ai37_agent_requests_total{service,transport,status}`,
  `ai37_agent_request_duration_seconds{service,transport}`,
  `ai37_agent_tasks_total{service,final_state}`, `ai37_billing_denied_total{service,reason}`,
  `ai37_agent_auth_failures_total{service}`. Эндпоинт смонтирован ДО `jwtGuard` (скрейпит
  внутрикластерный Alloy; порт агента не на публичном Ingress). Инкременты default-safe (сбой метрик
  не ломает ход); `service`-лейбл — фиксированный slug из `card.name` (кардинальность = 1 на процесс).
  Новая dependency `prom-client`. Инкременты — в `a2a-executor`/`agui`/`auth-guard`.

## [0.1.0-alpha.29] - 2026-07-16

### Fixed
- **`relay`: текст ответа сабагента больше не удваивается.** `collectTaskText` (за ним `extractText`)
  склеивал текст из `status.message.parts` И из text-частей ВСЕХ артефактов. Для агента, который
  пользуется штатным A2A-стримингом (`artifact-update` + `append: true`, см. alpha.23), это один и
  тот же ответ в двух каналах — дельтами в артефакте и снапшотом в `status.message` — поэтому
  оркестратор получал и печатал ответ ДВАЖДЫ. Теперь авторитет — `status.message` (он единственный
  переживает reconnect/`tasks/get`: прошлые `artifact-update` сервер не реплеит); text-артефакты
  считаются живой проекцией того же текста и НЕ суммируются. Fallback на артефакты сохранён на
  случай, когда терминального текста нет вовсе (агент отдал только стрим).
  - **Совместимость:** агентов на `createAgentHost` не затрагивает — у них артефакты несут только
    `kind:'data'` (`toTask`), поэтому канал ответа и был единственным. Меняется поведение лишь для
    агентов, стримящих ответ text-артефактами.

## [0.1.0-alpha.23] - 2026-07-10

### Added
- **`relay`: финальный текст и тул-коллы сабагента как прогресс-события.** `RemoteA2aProgressEvent`
  расширен вариантами `{type:'text', value}` и `{type:'tool', value, tool}` (в дополнение к
  `node`/`reasoning`). `drainStream` поднимает `artifact-update` (append) text-части как `text` —
  канонический потоковый ответ сабагента вместо готового блока в конце; `status-update` с metadata
  `ai37/tool` — как `tool` (карточка тул-колла). Text-события гейтятся `ev.append` (канон A2A:
  append=дельта, без append=снапшот/замена — не путать со стримом).

### Fixed
- **`agui.ts`: дублирование reasoning-карточки при чередовании reasoning/text в одном ходе.**
  `endReasoning()` закрывал открытый REASONING-блок эагерли на ПЕРВОМ `type:'text'` событии —
  расчёт был на паттерн «сначала reasoning, потом текст». Если агент возобновлял reasoning ПОСЛЕ
  того, как текст уже начал стримиться (несколько раундов planner/search у sub-agent'а, ответ-
  генератор с interleaved cot/answer-чанками), `ensureReasoningStart()` открывал ВТОРОЙ независимый
  REASONING-блок с новым id — две отдельные карточки «Thinking…» на одно логическое сообщение.
  Теперь reasoning закрывается только по факту завершения `run()`/ошибки — на визуал не влияет
  (CopilotKit сворачивает карточку в «Thought for Ns» по признаку «это не последнее сообщение», а
  не по факту `REASONING_END`).

## [0.1.0-alpha.20] - 2026-07-02

### Added
- **«Экспорт» агента как MCP Resource Server.** Новая опция `mcp` в `createAgentHost` монтирует
  `/mcp` (StreamableHTTP) + OAuth-discovery (`.well-known/oauth-protected-resource`, RFC 9728) за
  тем же verified auth, что A2A/AG-UI. Внешние MCP-клиенты (Claude/Cursor/…) подключают агента как
  набор tool'ов.
  - `mcp: { tools, scopes?, serverName? }` — `tools` это статический список `McpToolDef[]` ИЛИ
    per-request резолвер `(ctx) => McpToolDef[]` (для НАБОРА ПО ПОЛЬЗОВАТЕЛЮ из токена, напр.
    агрегатор оркестратора).
  - `mcpChallengeGuard`: на 401 отдаёт `WWW-Authenticate: Bearer resource_metadata="…"` (MCP-спека),
    проверку токена делает тот же `AgentContext.fromRequest`/`CompositeVerifier` (JWT→JWKS Authentik
    или API-ключ→introspection billing), открывает ALS-scope → tool handler видит `currentCtx()`.
  - `authorization_servers` в protected-resource-metadata деривятся из `agentContext.auth.issuers`
    (Authentik). Публичный MCP-URL — из `card.url` (тот же origin, что A2A).
  - `@modelcontextprotocol/sdk` и `zod` — **optional-peer** (грузятся динамически внутри MCP-пути),
    поэтому не-MCP потребители agent-host их не тянут.
  - Экспортированы низкоуровневые примитивы (`buildMcpServer`, `protectedResourceMetadataRouter`,
    `mcpHttpHandler`, …) — для потребителей вне agent-host (напр. NestJS rag-factory со своим guard'ом).
  - Аддитивно и обратно совместимо: без опции `mcp` поведение хоста не меняется.

## [0.1.0-alpha.14] - 2026-06-23

### Added
- **Трансляция прогресса/COT в UI (chain-of-thought).** `AgentEvent` расширен вариантами
  `{type:'reasoning', delta}` и `{type:'tool', phase, name, args?, result?}` (в дополнение к
  `node`/`text`/`a2ui`).
  - `agui.ts`: `reasoning` → нативные `REASONING_*` (CopilotKit рисует встроенную сворачивающуюся
    карточку «Thinking…» → «Thought for Ns»); `node` вливается строкой в ту же карточку; `tool` →
    `TOOL_CALL_*` (встроенный `DefaultToolCallRenderer`). reasoning-блок закрывается до финального
    текста/`RUN_FINISHED`.
  - `a2a-executor.ts`: на A2A-пути `emit({type:'node'|'reasoning'})` публикует `status-update` с
    `metadata['ai37/node'|'ai37/reasoning']` (лениво, после первого emit — initial working-Task).
    Для блокирующего `message/send` сворачивается `ResultManager`'ом в финальный Task —
    **поведение прежнее**; агенты без emit ничего лишнего не публикуют.
  - `relay`: новый `executeRemoteA2aStreaming(client, req, onEvent)` — вызов сабагента по
    `message/stream`, форвардит node/reasoning через `onEvent`, накапливает финальный `Message|Task`
    (контракт результата идентичен `executeRemoteA2a`). Экспортирован `RemoteA2aProgressEvent`.
  - Аддитивно и обратно совместимо.

## [0.1.0-alpha.12] - 2026-06-22

### Fixed
- `typesVersions` для subpath `./relay` — чтобы потребители с `moduleResolution: node`
  (node10; напр. NestJS chat-backend) резолвили типы `@ai37/agent-host/relay`
  (иначе TS2307, хотя рантайм Node читает `exports`). Зеркалит подход `@a2a-js/sdk`.
  Только упаковка; код `/relay` без изменений.

## [0.1.0-alpha.11] - 2026-06-22

### Added
- **A2A-путь читает A2UI-действие (симметрия с AG-UI).** `parse.ts` достаёт
  `message.metadata.a2uiAction.userAction` → `AgentInput.action` (как `agui.ts`
  читает `forwardedProps.a2uiAction.userAction`). Так оркестратор форвардит
  клик/submit формы вниз конечному агенту по A2A. Аддитивно; обычный ход без
  действия не затронут.
- **Subpath `@ai37/agent-host/relay`** — переносимая A2A-relay-механика, чтобы
  любой агент мог быть relay (вызывать другого агента), не дублируя код:
  `executeRemoteA2a(client, req)` (сборка Message + `sendMessage` + stale-resume
  retry + разбор Task → `{text, a2ui, taskId, state}`), форвардит вниз
  `action`/негоциацию/`context_refs`; чистые хелперы `extractText`/`extractA2ui`/
  `isStaleTaskError`; интерфейс `RemoteTaskStore` + `InMemoryRemoteTaskStore`
  (durable-реализацию инжектит потребитель). Транспорт-агностично (без
  LangChain/deepagents/NestJS); листы, не импортирующие subpath, не тянут
  `@a2a-js/sdk/client` в бандл.

## [0.1.0-alpha.10] - 2026-06-22

### Removed
- Удалена TOOL_CALL-механика (alpha.9): канон UI-интерактива — ACTIVITY_SNAPSHOT
  (`input.action`, alpha.10), TOOL_CALL был мёртвым кодом. Убрано: вариант
  `AgentEvent` `{type:'tool-call'}` и его эмит `TOOL_CALL_START/ARGS/END`;
  `AgentInput.tools` / `AgentInput.toolResult`; тип `ToolResult`; AG-UI-приёмник
  (`RunAgentInput.tools`, `role=tool` → `toolResult`). **Breaking**, но потребителей
  не было (агент и spai-ui перешли на `input.action` до удаления).

### Added
- Приём A2UI-действия (канон ACTIVITY_SNAPSHOT, не TOOL_CALL): host читает
  `forwardedProps.a2uiAction.userAction` (клик кнопки/submit формы от
  `createA2UIMessageRenderer`) → `AgentInput.action = {name, context, surfaceId?,
  sourceComponentId?}`. Новый тип `A2uiAction`. `name` — что нажато
  (`apply`/`nav:building`/...), `context` — значения полей (submit) или `{}`.
  Чтение `forwardedProps.data` → `input.data` не затронуто; нет `a2uiAction` →
  `input.action` undefined. TOOL_CALL-механика (alpha.9) остаётся (отдельный clean-up).

## [0.1.0-alpha.9] - 2026-06-21

### Added
- HITL frontend-tools (канон AG-UI TOOL_CALL): `AgentEvent` вариант
  `{type:'tool-call', toolName, args, toolCallId?}` → host эмитит
  `TOOL_CALL_START/ARGS/END`. Вход: `AgentInput.tools` (frontend-tools клиента из
  `RunAgentInput.tools`) и `AgentInput.toolResult` (ответ `role=tool` →
  `{toolCallId, result}`, JSON-парсинг content). Тип `ToolResult`. Замыкает цикл
  «агент шлёт форму → юзер жмёт → значения возвращаются агенту».

## [0.1.0-alpha.8] - 2026-06-21

### Added
- `ChatAttachmentsStoreBackend` / `ProjectAttachmentsStoreBackend` — StoreBackend'ы вложений
  (файлы → markdown) поверх REST chat-backend (`/api/chat-attachments`, `/api/project-attachments`).
  Монтируются в deepagents `CompositeBackend` на `/chat-attachments/` и `/project-attachments/`;
  read-only (`ls`/`read`/`grep`/`glob`), scope (`contextId`/`projectId`) — из резолвера хода.

## [0.1.0-alpha.6] - 2026-06-18

### Added
- Add taskStore param to createAgentHost

## [0.1.0-alpha.4] - 2026-06-17

### Added
- Content-negotiation вывода (РЕШЕНИЕ 10): чтение `acceptedOutputModes` — для A2A из нативного
  `params.configuration` (через guard → ALS, т.к. `@a2a-js/sdk` не пробрасывает `configuration`
  в executor), для AG-UI из `forwardedProps.ai37`. Резолв `negotiation` из agent-card
  `defaultOutputModes`; хелпер `currentAcceptedOutputModes` (симметрично `currentBearer`).

### Changed
- **BREAKING:** enforcement формата вывода в хосте — текст эмитится всегда, A2UI только при явном
  запросе клиента (дефолт — текст), `catalogId` берётся из негоциации. `AgentInput` получил поля
  `negotiation` и `acceptedOutputModes`.

## [0.1.0-alpha.3] - 2026-06-16

### Added
- Тонкий хост `createAgentHost`: A2A JSON-RPC (`/a2a/v1`) + AG-UI SSE (`/agui`) + agent-card +
  health/version, за JWT-guard'ом (verified `AgentContext` в request-scope через ALS).
- Канон AG-UI: A2UI-компоненты как `ACTIVITY_SNAPSHOT` `a2ui-surface` с `a2ui_operations` (v0.9),
  рендеримые CopilotKit нативно.
- Multi-turn/HITL: состояние хода персистится в task-store (`interrupt` → followup → resume).
- Dev-режим (insecure-dev / fake billing) через env, fail-closed в проде.
