# AG-UI TOOL_CALL для HITL (host)

## Why

Интерактивные формы/кнопки от агента (HITL) в стеке CopilotKit v2 + AG-UI
работают **только** через канал `TOOL_CALL`. Текущий host (`ts-host`) эмитит
лишь `TEXT_MESSAGE_*` и `ACTIVITY_SNAPSHOT` (a2ui-surface). ACTIVITY_SNAPSHOT
рисует форму, но **клик не отдаёт наружу** — обратный путь (значения → агент)
невозможен. Проверено спайком: цикл замыкается только через TOOL_CALL.

Комментарий в `agui.ts` это и фиксировал: «Tool-call `render_a2ui` НЕ
используем». Эта ветка просто не реализована — не баг, а недоработанный канон.

## What Changes

В `@ai37/agent-host` (`packages/ts-host`):

- **Эмит TOOL_CALL**: новый вариант `AgentEvent` `{type:'tool-call', toolName,
  args, toolCallId?}`. Host транслирует его в `TOOL_CALL_START` →
  `TOOL_CALL_ARGS` → `TOOL_CALL_END` (через `@ag-ui/encoder`).
- **Чтение `tools[]`**: входящий `RunAgentInput.tools` (frontend-tools,
  заявленные клиентом) пробрасывается в `AgentInput.tools`.
- **Приём tool-result**: сообщение `role=tool` в `messages[]` (ответ юзера через
  `respond()`) парсится в `AgentInput.toolResult` (`toolCallId`, `result`).
- Новые типы: `ToolResult`, поля `AgentInput.tools` / `AgentInput.toolResult`,
  вариант `AgentEvent` `tool-call`.

## Impact

- Затрагивает только `packages/ts-host` (`agui.ts`, `types.ts`). A2A-путь и
  ACTIVITY_SNAPSHOT не меняются — TOOL_CALL добавляется рядом.
- **Зависимость потребителей:** агенты и UI, использующие HITL, требуют этой
  версии host (`alpha.7` → `alpha.8`). Доставка — через `npm link`/`file:`/подмену
  dist; npm-публикация не обязательна (всё в одном круге репо).
- **Non-goals:** не трогаем A2A-транспорт, биллинг, негоциацию каталогов,
  python-host. LLM-генерацию UI (`render_a2ui` от модели) не вводим — tool-call
  эмитит сам агент детерминированно.
