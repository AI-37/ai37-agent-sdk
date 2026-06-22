# Приём A2UI-действия (a2uiAction) во вход агента (host)

## Why

Канонический путь интерактива в нашей BFF-схеме — **ACTIVITY_SNAPSHOT**, не
TOOL_CALL. Спайком 2026-06-22 доказано (живой клик в браузере): когда пользователь
жмёт кнопку/submit A2UI-компонента, `createA2UIMessageRenderer` (CopilotKit) кладёт
действие в `forwardedProps.a2uiAction.userAction = { name, context, surfaceId,
sourceComponentId }` и дёргает агента через `runAgent`.

Но host (`ts-host/agui.ts`) читает только `forwardedProps.data` → `input.data`.
Поле `a2uiAction` он **игнорирует** — значит клик до handler'а не доходит как
действие. Нужно научить host его принимать.

Это **заменяет** TOOL_CALL-подход (change `agui-toolcall-hitl`): TOOL_CALL в нашей
схеме не нужен — ACTIVITY_SNAPSHOT самодостаточен (рисует дерево + возвращает клик).

## What Changes

В `@ai37/agent-host` (`packages/ts-host`):

- **Чтение `a2uiAction`**: `forwardedProps.a2uiAction.userAction` →
  `AgentInput.action = { name, context, surfaceId?, sourceComponentId? }`.
- Новый тип `A2uiAction` (`name: string`, `context: Record<string,unknown>`, ...).
- Поле `AgentInput.action?: A2uiAction`.
- TOOL_CALL-механика (`agui-toolcall-hitl`) больше не нужна для UI-интерактива —
  пометить как устаревшую (откат — отдельным шагом, чтобы не ломать существующее).

## Impact

- Затрагивает `packages/ts-host` (`agui.ts` чтение входа, `types.ts` типы).
  ACTIVITY_SNAPSHOT-эмит (`emitA2ui`/`flatten`) НЕ меняется — он уже шлёт дерево.
- **Потребители:** агент читает клик из `input.action` (вместо `input.toolResult`).
- **Non-goals:** A2A-путь; ACTIVITY_SNAPSHOT-эмит (готов); удаление TOOL_CALL-кода
  (отдельный clean-up, чтобы не ломать сразу). Бамп версии host.
