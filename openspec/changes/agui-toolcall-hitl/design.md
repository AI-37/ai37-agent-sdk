# Design — AG-UI TOOL_CALL для HITL (host)

## Approach

Добавляем TOOL_CALL как третий канал вывода рядом с text и a2ui — не заменяя их.
Эмит идёт через тот же `EventEncoder` и `EventType.TOOL_CALL_*` из `@ag-ui/core`
(они уже есть в пакете). Вход расширяется чтением `body.tools` и сообщений
`role=tool`. Спайк подтвердил рабочесть всей цепочки живым кликом.

## Files

| Файл | Действие |
| --- | --- |
| `packages/ts-host/src/types.ts` | Тип `ToolResult`; поля `AgentInput.tools`, `AgentInput.toolResult`; вариант `AgentEvent` `{type:'tool-call'}`. |
| `packages/ts-host/src/agui.ts` | `lastToolResult(messages)`; чтение `body.tools` → `input.tools`; `emitToolCall()` (START/ARGS/END); ветка `e.type==='tool-call'` в `emit`. |

## Decisions

### 1. TOOL_CALL — отдельный AgentEvent, не замена a2ui

`AgentEvent` получает вариант `{type:'tool-call', toolName, args, toolCallId?}`.
Агент сам решает, когда вызвать frontend-tool (детерминированно, не через LLM).
ACTIVITY_SNAPSHOT остаётся для презентационного A2UI (таблицы, отчёт) — клик там
не нужен. TOOL_CALL — для интерактива (форма ждёт ответа).

### 2. toolCallId генерирует host, если агент не задал

`emitToolCall(toolName, args, id?)` → `id ?? 'call-' + uuid`. Возвращает id для
корреляции. Агенту не обязательно его придумывать; для multi-tool сценариев
может задать сам.

### 3. tool-result: парсим JSON content, fallback на строку

`lastToolResult` берёт последнее `role=tool` сообщение. `content` обычно строка
(JSON значений формы из `respond()`); пробуем `JSON.parse`, при ошибке —
оставляем строкой. `toolCallId` связывает с исходным вызовом.

### 4. Args сериализуем в TOOL_CALL_ARGS как один JSON-delta

AG-UI допускает стриминг args по частям. Для детерминированного агента весь
объект известен сразу → один `TOOL_CALL_ARGS` с `delta: JSON.stringify(args)`.
Проще и достаточно; стриминг можно добавить позже без слома контракта.

## Edge cases

- **Нет `body.tools`** → `input.tools` undefined; агент не эмитит tool-call,
  работает как раньше (текст/a2ui).
- **role=tool без toolCallId** → `toolCallId: ''`; result всё равно доходит.
- **Старый клиент без frontend-tools** → tool-call в пустоту (CopilotKit не
  найдёт tool по имени). Агент должен проверять `input.tools` перед эмитом.

## Non-goals

A2A-путь, биллинг, негоциация, python-host — не трогаем. Стриминг args по частям
и LLM-генерация UI — вне этого change.
