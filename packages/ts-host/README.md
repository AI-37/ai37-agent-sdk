# @ai37/agent-host

HTTP-хост для **агентов** экосистемы AI37: `createAgentHost(...)` собирает Express-приложение с
**A2A** (JSON-RPC), **AG-UI** (SSE), JWT-guard и health/version — поверх [`@ai37/agent-sdk`](https://www.npmjs.com/package/@ai37/agent-sdk).
Транспорт и auth/billing-обвязка живут здесь; когниция агента (intent/work/critic/respond) — в самом
агенте.

```ts
import { createAgentHost, type AgentHandler } from "@ai37/agent-host";

const handler: AgentHandler = {
  async run({ input, ctx, emit }) {
    // ctx — verified @ai37/agent-sdk AgentContext (claims + billing)
    return { status: "completed", a2ui: [/* ai37-a2ui-catalog */], result: {} };
  },
};

const app = createAgentHost({
  card,                         // Ai37AgentCardInput: поля A2A 0.3 + x-ai37
  handler,
  agentContext: {
    auth: { issuer, audience, jwksUrl, required: true },
    billing: { baseUrl: BILLING_BASE_URL },
  },
});
app.listen(8080);
```

## Что даёт host

- `/.well-known/agent-card.json` — discovery;
- `/a2a/v1` — A2A JSON-RPC (`message/send`, `message/stream`), за JWT-guard;
- `/agui` — AG-UI SSE (стрим событий когниции);
- `/api/v1/health`, `/api/v1/version`;
- JWT-guard через `AgentContext.fromRequest` (`@ai37/agent-sdk`) + request-scope (claims/billing → handler).

## Контракт

Агент реализует `AgentHandler.run(req)` — получает нормализованный `AgentInput` + verified `AgentContext`,
возвращает `AgentResult` (`status` + опц. `a2ui`/`message`/`followup`/`result`/`state`). Host не содержит
доменной логики.

## Трассировка: содержимое хода не пишется по умолчанию

Host сам открывает turn-спан и включает Langfuse из env (`LANGFUSE_PUBLIC_KEY`/`SECRET_KEY`/`BASE_URL`;
без ключей — полный no-op). **Содержимое хода в трейс не попадает**: вместо текста пользователя идёт
`textLen`, вместо результата — `status` и `messageLen`.

Причина: спан привязан к `userId` и `sessionId`, поэтому содержимое становится профилируемым по
конкретному человеку и уезжает туда, где развёрнут Langfuse. Агенты на этом хосте обрабатывают
персональные данные третьих лиц, так что безопасный дефолт общий: структура и тайминги — да,
содержимое — только по явному решению.

| Переменная | По умолчанию | Что делает |
| --- | --- | --- |
| `LANGFUSE_CAPTURE_CONTENT` | `false` | `true` — писать текст, промпты и результат как раньше |

При выключенном захвате процессору дополнительно ставится `mask`: она применяется ко **всем** спанам
перед экспортом, включая те, что создаёт `@langfuse/langchain` (промпты и ответы модели) — их host не
строит и иначе не контролирует. Служебная метаданная `trace.v1` пропускается по маркеру
`schemaVersion`, поэтому `turnId`, статус, канал и тенант в трейсе остаются. Токены и тайминги живут в
`gen_ai.usage.*` и маской не затрагиваются.

Что сохраняется в любом режиме: дерево спанов, `sessionId`/`userId`, статусы, длительности,
распределённый trace-context между сервисами.

## Multi-turn / HITL (состояние хода — server-side)

Для уточняющих вопросов (мастер/HITL) состояние живёт в **task-store**, а не у клиента:

```ts
async run({ input }) {
  const step = (input.taskState?.step as number) ?? 0;   // состояние прошлого хода
  if (step === 0) {
    return {
      status: "input-required",
      followup: { component: "ChoiceCard", props: { /* ai37-a2ui-catalog */ } },
      state: { step: 1 },                                  // host персистит в task.metadata
    };
  }
  return { status: "completed", result: /* ... */ };
}
```

На следующем `message/send` с тем же `taskId` host грузит прошлый Task и отдаёт его состояние в
`input.taskState`. По умолчанию хранилище — `InMemoryTaskStore` (per-process). Для durable
(переживает рестарт/реплики) передайте свой `taskStore` в `createAgentHost({ ..., taskStore })`.
`TaskStore` и `InMemoryTaskStore` хост реэкспортирует, своя зависимость от `@a2a-js/sdk` ради них
агенту не нужна.

**Владелец задачи.** Хост передаёт стору `ServerCallContext` с пользователем из JWT хода:
`userName = "<org_id>:<sub>"` (как python-host). Так делают и A2A-путь (`userBuilder` обработчика),
и AG-UI-путь. Стор `@a2a-js/sdk` 1.x адресует задачу парой (владелец, id), поэтому чужой `taskId`
не открывает чужую паузу. На 0.3 стор контекст игнорирует, но хост передаёт его уже сейчас.

**REST-ручки агента** (протокол, черновик формы, рекомендации) работают с состоянием хода через
хелперы, а не через `taskStore.load/save`:

```ts
import { loadTaskState, saveTaskState } from "@ai37/agent-host";

app.get("/api/draft", guard, async (req, res) => {
  const state = await loadTaskState(taskStore, String(req.query.taskId)); // от имени пользователя запроса
  if (!state) return res.status(404).json({ error: "task_expired" });   // нет, истекла или чужая
  res.json({ draft: state.draft ?? null });
});

await saveTaskState(taskStore, taskId, { ...state, draft }); // false — задачи нет
```

Хелперы не зависят от формы `Task` в SDK и переживут переход на `@a2a-js/sdk` 1.x без правок.
Если нужен сам стор, `currentCallContext()` даёт тот же контекст: `taskStore.load(id, currentCallContext())`.

На AG-UI `taskId = threadId`, задача живёт весь тред. Её снимок хост пишет без терминального
статуса (`completed`/`failed` хода → `unknown`), иначе после первого `completed` тред бы замёрз.

## Артефакты: результат хода, который нужен дольше хода

Протокол расчёта, документ, пакет — это артефакт. Агент публикует его в выходную полку chat-backend
(`POST /api/artifacts`) от имени пользователя: user-JWT и диалог `publishArtifact` берёт из
request-scope хода (`currentBearer`, `currentTurnContext`). Если их нет, вызов падает с `no_scope`,
публикации «от никого» не бывает.

```ts
const artifact = await publishArtifact({
  baseUrl: process.env.CHAT_BACKEND_URL!,
  kind: 'lift-report',
  name: 'Протокол расчёта лифтов',
  markdown: report,              // DOCX chat-backend рендерит из него сам
  producerAgentId: 'elevator-calc',
})
// в ответ агента: A2UI-карточка артефакта или markdown-ссылка artifact.url
```

- Байты по A2A не ходят: в ответе агента — ссылка и `artifact.ref` (`artifact:<id>`).
- Повтор того же вызова в том же ходе безопасен. Ключ идемпотентности выводится из хода и
  содержимого, и chat-backend вернёт уже записанный артефакт (`created: false`).
- Ошибки приходят как `ArtifactPublishError` с кодом (`not_found`, `conflict`, `too_large`,
  `rate_limited`, `storage_unavailable`, `network_error`, …). В тексте ошибки нет ни тела
  артефакта, ни ответа сервера.

Читают артефакты другие агенты через `ArtifactsStoreBackend` (read-only, `/artifacts/` и
`/project-artifacts/` в `CompositeBackend`) по явному ref или поиском по проекту. В
`context_files` артефакты не попадают (ADR 13).

## Установка

```bash
npm i @ai37/agent-host @ai37/agent-sdk
```

`@ai37/agent-sdk` — peer-зависимость (auth + billing). Лицензия: Apache-2.0.
