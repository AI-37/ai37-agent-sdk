# Tasks — приём a2uiAction во вход агента (host)

## 1. Тип (`packages/ts-host/src/types.ts`)

- [x] Тип `A2uiAction { name: string; context: Record<string, unknown>; surfaceId?: string; sourceComponentId?: string }`.
- [x] Поле `AgentInput.action?: A2uiAction`.

## 2. Чтение входа (`agui.ts`)

- [x] В `RunAgentInputLike.forwardedProps` учесть `a2uiAction.userAction`.
- [x] В сборке `input`: `const action = body.forwardedProps?.a2uiAction?.userAction`
      → если есть → `input.action = { name, context: context ?? {}, surfaceId, sourceComponentId }`.
- [x] Не ломать существующее чтение `forwardedProps.data` → `input.data`.

## 3. Тесты (vitest, `test/host.test.ts`)

- [x] Вход с `forwardedProps.a2uiAction.userAction{name:'apply', context:{N:'15'}}`
      → `input.action.name === 'apply'`, `input.action.context.N === '15'`.
- [x] Вход с `a2uiAction{name:'nav:building', context:{}}` → `input.action.name === 'nav:building'`.
- [x] Вход без `a2uiAction` → `input.action === undefined`, `input.data` работает.

## 4. Проверки

- [x] `npm run lint` (tsc --noEmit) — зелёный.
- [x] `npm run test` — все тесты зелёные.
- [x] `npm run build` — dist собран.

## 5. Доставка

- [x] Бамп версии `@ai37/agent-host` (alpha.9 → alpha.10), CHANGELOG.
- [ ] Подмена собранного dist в node_modules потребителя (агент) для локалки;
      npm-публикация — по необходимости.

## Non-goals

- TOOL_CALL-код (`agui-toolcall-hitl`) НЕ удаляем в этом change (отдельный clean-up).
- A2A-путь, ACTIVITY_SNAPSHOT-эмит — не трогаем.
