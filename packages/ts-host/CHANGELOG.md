# Changelog — @ai37/agent-host

Формат: [Keep a Changelog](https://keepachangelog.com/). Версия — `package.json` этого пакета;
публикуется независимо от `@ai37/agent-sdk` (от которого зависит как peer).

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
