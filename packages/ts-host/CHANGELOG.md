# Changelog — @ai37/agent-host

Формат: [Keep a Changelog](https://keepachangelog.com/). Версия — `package.json` этого пакета;
публикуется независимо от `@ai37/agent-sdk` (от которого зависит как peer).

## [0.1.0-alpha.8] - 2026-06-21

### Added
- HITL frontend-tools (канон AG-UI TOOL_CALL): `AgentEvent` вариант
  `{type:'tool-call', toolName, args, toolCallId?}` → host эмитит
  `TOOL_CALL_START/ARGS/END`. Вход: `AgentInput.tools` (frontend-tools клиента из
  `RunAgentInput.tools`) и `AgentInput.toolResult` (ответ `role=tool` →
  `{toolCallId, result}`, JSON-парсинг content). Тип `ToolResult`. Замыкает цикл
  «агент шлёт форму → юзер жмёт → значения возвращаются агенту».
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
