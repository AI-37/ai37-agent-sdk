# Tasks — AG-UI TOOL_CALL для HITL (host)

## 1. Типы (`packages/ts-host/src/types.ts`)

- [x] Тип `ToolResult` (`toolCallId: string`, `toolName?: string`, `result: unknown`).
- [x] `AgentInput.tools?: Array<{name; description?; parameters?}>` — frontend-tools от клиента.
- [x] `AgentInput.toolResult?: ToolResult` — ответ юзера (role=tool).
- [x] Вариант `AgentEvent` `{type:'tool-call'; toolName; args; toolCallId?}`.

## 2. Чтение входа (`agui.ts`)

- [x] `RunAgentInputLike`: добавить `tools?` и в messages `toolCallId?`/`toolName?`.
- [x] `lastToolResult(messages)` — последнее `role=tool`, парсинг content (JSON→fallback строка).
- [x] В сборке `input`: пробросить `tools` (фильтр по `name:string`) и `toolResult`.

## 3. Эмит TOOL_CALL (`agui.ts`)

- [x] `emitToolCall(toolName, args, id?)` — START → ARGS(JSON) → END, вернуть toolCallId.
- [x] Ветка `e.type === 'tool-call'` в `emit`-callback handler.run.

## 4. Проверки

- [x] `npm run lint` (tsc --noEmit) в ts-host — зелёный.
- [x] Подтвердить, что `EventType.TOOL_CALL_START/ARGS/END` есть в `@ag-ui/core` (есть).
- [x] `npm run build` (tsup) — `dist` содержит TOOL_CALL.

## 5. Тесты (vitest, `test/host.test.ts`)

- [x] Тест: вход с `tools:[{name:'render_form'}]` → `input.tools` доходит до handler.
- [x] Тест: handler эмитит `{type:'tool-call'}` → в SSE есть TOOL_CALL_START/ARGS/END.
- [x] Тест: вход с `role=tool` сообщением → `input.toolResult.result` распарсен.

## 6. Доставка потребителям (публикация НЕ обязательна)

- [x] Бамп версии `@ai37/agent-host` (`alpha.7` → `alpha.8`), CHANGELOG.
- [x] Выбрать способ связи (всё в одном круге репо — npm-публикация не нужна):
      `npm link`, `file:`-зависимость, или подмена собранного `dist` в node_modules.
      Публиковать в npm — только если host тянут проекты вне этих трёх.
- [x] Отметить зависимость: change агента и spai-ui требуют этой версии host.
