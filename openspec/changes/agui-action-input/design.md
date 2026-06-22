# Design — приём a2uiAction во вход агента (host)

## Approach

Добавляем чтение `forwardedProps.a2uiAction` в сборку `AgentInput` (рядом с
существующим чтением `forwardedProps.data`). Минимальная точечная правка —
ACTIVITY_SNAPSHOT-эмит уже работает (`flatten`/`emitA2ui`), трогаем только вход.
Формат `a2uiAction` подтверждён спайком (реальный payload из браузера).

## Реальный payload (из спайка)

```json
"forwardedProps": {
  "a2uiAction": {
    "userAction": {
      "name": "nav:building",        // или 'apply' (submit формы)
      "context": { "N": "15" },      // значения полей (для submit) или {}
      "surfaceId": "surf-...",
      "sourceComponentId": "root.children.0.children.0"
    }
  }
}
```

## Files

| Файл | Действие |
| --- | --- |
| `packages/ts-host/src/types.ts` | Тип `A2uiAction { name; context; surfaceId?; sourceComponentId? }`; поле `AgentInput.action?: A2uiAction`. |
| `packages/ts-host/src/agui.ts` | В сборке `input`: прочитать `body.forwardedProps?.a2uiAction?.userAction` → `input.action`. `RunAgentInputLike.forwardedProps` уже есть. |

## Decisions

### 1. Отдельное поле `input.action`, не в `data`

Клик кладём в `AgentInput.action` (типизированно), не мешаем с `input.data`
(там прочее из forwardedProps). Так handler явно различает «пользователь нажал
кнопку/submit» (`input.action`) и обычные данные. `name` несёт что нажато
(`apply`/`nav:building`/...), `context` — значения формы (для submit) или `{}`.

### 2. ACTIVITY_SNAPSHOT-эмит не трогаем

`flatten`/`emitA2ui`/`componentToA2uiOperations` уже разворачивают дерево
(Column/Row/Button/FormCard) в v0.9. Доказано спайком — рисуется. Меняем ТОЛЬКО
приём входящего действия.

### 3. TOOL_CALL — устаревает, но не удаляем сразу

`agui-toolcall-hitl` (emit TOOL_CALL, `input.tools`/`toolResult`) для UI-интерактива
больше не нужен (ACTIVITY_SNAPSHOT самодостаточен). НО удаление — отдельный
clean-up change, чтобы не ломать то, что уже опубликовано (alpha.9). Пока просто
не используем; `input.action` — новый канон.

## Edge cases

- **Нет `a2uiAction`** (обычный текст/первый ход) → `input.action` undefined,
  работает как раньше.
- **`context` пустой** (клик кнопки навигации) → `action.context = {}`.
- **`context` со значениями** (submit формы) → строки полей; коэрс — на агенте.

## Non-goals

A2A-путь, ACTIVITY_SNAPSHOT-эмит, удаление TOOL_CALL-кода (отдельно). Схемы.
