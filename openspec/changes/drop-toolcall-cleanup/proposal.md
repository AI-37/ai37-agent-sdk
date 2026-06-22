# Удалить TOOL_CALL-механику из host (clean-up)

## Why

TOOL_CALL-путь (`agui-toolcall-hitl`, host alpha.9) задумывался для HITL-интерактива,
но спайком 2026-06-22 доказано: канон в нашей BFF-схеме — **ACTIVITY_SNAPSHOT**
(`input.action`, change `agui-action-input`). TOOL_CALL для UI-интерактива больше
не используется ни агентом, ни spai-ui.

Код TOOL_CALL **оставлен** в alpha.10 намеренно (чтобы не ломать опубликованное),
но он мёртвый. Этот change — отложенная чистка: убрать неиспользуемое.

## What Changes (когда дойдёт черёд)

В `@ai37/agent-host` (`packages/ts-host`):

- Убрать эмит TOOL_CALL: вариант `AgentEvent` `{type:'tool-call'}`, `emitToolCall`,
  ветку в `emit`-callback (`agui.ts`).
- Убрать приём tool-result: `lastToolResult`, поля `AgentInput.tools` /
  `AgentInput.toolResult`, тип `ToolResult`.
- Убрать AG-UI приёмник TOOL_CALL: `RunAgentInputLike.tools` и поля
  `toolCallId`/`toolName` в `RunAgentInputLike.messages`, маппинг `body.tools` →
  `input.tools` (`agui.ts`). Проверено: эти поля используются ИСКЛЮЧИТЕЛЬНО
  TOOL_CALL-логикой (`lastToolResult`/tools-маппинг), вне неё — нигде.
- Обновить тесты (удалить блок TOOL_CALL HITL), CHANGELOG.

Принцип: чистим ВСЁ связанное с TOOL_CALL (не полузачистка) — иначе остаются
мёртвые поля без смысла.

## Impact

- **Только после** того как все потребители перешли на `input.action`:
  агент (`wizard-52941-tree`) и spai-ui (`drop-rendertool-activity`) реализованы и
  смержены, TOOL_CALL нигде не вызывается.
- **Non-goals:** `input.action`/ACTIVITY_SNAPSHOT (канон, остаётся); A2A-путь.
- **Предусловие:** проверить, что ни один агент/UI не использует tools/toolResult
  до удаления.
