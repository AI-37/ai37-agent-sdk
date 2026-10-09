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
- `/a2a/v1` — A2A JSON-RPC за JWT-guard: протокол 1.0 (`SendMessage`, `SendStreamingMessage`, …,
  заголовок `A2A-Version: 1.0`) и 0.3 (`message/send`, `message/stream`; без заголовка) — см. ниже;
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
(переживает рестарт/реплики) — Postgres-стор `Ai37TaskStore` из `@ai37/agent-host/task-store`, см.
раздел «Стор задач на Postgres» ниже.
`TaskStore` и `InMemoryTaskStore` хост реэкспортирует, своя зависимость от `@a2a-js/sdk` ради них
агенту не нужна.

**Владелец задачи.** Хост передаёт стору `ServerCallContext` с пользователем из JWT хода:
`userName = "<org_id>:<sub>"` (как python-host). Так делают и A2A-путь (`userBuilder` обработчика),
и AG-UI-путь. Стор `@a2a-js/sdk` 1.x адресует задачу парой (владелец, id), поэтому чужой `taskId`
не открывает чужую паузу.

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
статуса (`completed`/`failed` хода → `TASK_STATE_UNSPECIFIED`), иначе после первого `completed` тред
бы замёрз.

## Стор задач на Postgres (`@ai37/agent-host/task-store`)

Durable A2A TaskStore: upstream `DatabaseTaskStore` из `@a2a-js/sdk` 1.x плюс то, чего в нём нет
(паритет с python-host `PostgresTaskStore`):

- **владелец** задачи — `<org_id>:<sub>` из JWT хода; чужой `taskId` не читается и не
  перезаписывается (та же id другого владельца — отдельная строка);
- **завершённая задача неизменяема**: запись поверх completed/failed/canceled/rejected пропускается
  с предупреждением (снимок AG-UI со статусом `UNSPECIFIED` — не завершённый, пишется каждым ходом);
- **id до 255 символов** (`th_<uuid>` старых тредов — 39), длиннее — `RequestMalformedError`;
- **гигиена строки**: `history` режется до последних 20 сообщений (`historyLimit`), вехи прогресса
  (`ai37/node`, `ai37/reasoning`, `ai37/tool`) в `metadata` не сохраняются;
- **схема — шагом деплоя, проверка — на старте**, **ретенция — CronJob'ом**.

`kysely` и `pg` — optional peers: ставит только агент, которому нужен Postgres.

```bash
npm i @ai37/agent-host kysely pg
```

```ts
import { createAgentHost } from "@ai37/agent-host";
import { assertTaskStoreReady, createTaskStoreFromEnv } from "@ai37/agent-host/task-store";

// DATABASE_URL → Ai37TaskStore; без него в production — ошибка (тихого отката на память нет),
// в dev/тестах — InMemoryTaskStore.
const taskStore = createTaskStoreFromEnv();
await assertTaskStoreReady(taskStore); // нет таблицы / чужая / узкие колонки → под не стартует
createAgentHost({ card, handler, agentContext, taskStore }).listen(8080);
```

Таблица — `public.a2a_tasks` (схема — текущая для роли, обычно `public`), журнал миграций
`a2a_a2a_tasks_migrations`, лок мигратора `a2a_migrations_lock`. Схему создаёт и проверяет CLI
(строка подключения — только из `DATABASE_URL`):

| Команда | Что делает |
| --- | --- |
| `ai37-agent-host-task-store migrate` | чужая таблица `a2a_tasks` с другой схемой → отказ без изменений; `a2a-db upgrade --store tasks` (SQL upstream); `id`/`context_id` → `varchar(255)`; `check`. Идемпотентно, параллельные запуски разводит лок мигратора |
| `ai37-agent-host-task-store check` | таблица есть, это таблица задач A2A от `a2a-db`, ширина 255; иначе exit 1 и понятное сообщение |
| `ai37-agent-host-task-store cleanup` | завершённые старше `--terminal-days` (7), незавершённые старше `--stale-days` (14, не меньше terminal; `--keep-stale` — не трогать), пачками `--batch-size` (1000). Строки без таймстемпа не удаляются |

**Деплой (чарт агента).**

- `DATABASE_URL` — из runtime-секрета terraform (база на platform Postgres, права `CREATE` и DML).
- **initContainer `migrate`** перед основным контейнером, тот же образ:
  `command: ["npx", "--no-install", "ai37-agent-host-task-store", "migrate"]` (или
  `node node_modules/@ai37/agent-host/dist/cli/task-store.js migrate`). Реплики запускают его
  одновременно — это безопасно.
- **CronJob `task-store-retention`** раз в сутки ночью, тот же образ:
  `ai37-agent-host-task-store cleanup --terminal-days $(TASK_STORE_TERMINAL_DAYS) --stale-days
  $(TASK_STORE_STALE_DAYS)` (несекретные vars `<ENV>_APP_*` с дефолтами 7 и 14 в `values.yaml`).
  **Метки пода Job'а — НЕ `selectorLabels`**: иначе Service агента будет слать трафик в под CronJob'а.
  Дайте Job'у свои метки (`app.kubernetes.io/component: task-store-retention`).

Тесты стора идут против настоящего Postgres: `TEST_DATABASE_URL` (роль с правом `CREATE DATABASE`,
каждый блок создаёт и удаляет свою базу). Локально:

```bash
docker run -d --name ts-host-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55471:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55471/postgres npm test
docker rm -f ts-host-pg
```

## Протокол A2A: 1.0 и 0.3 одновременно

Хост стоит на `@a2a-js/sdk` 1.x и по умолчанию принимает клиентов 0.3 (`legacyCompat`): во время
перехода chat-backend, MCP-агрегатор и внешние клиенты обновляются не вместе с агентами.

- Карточка гибридная: поля 0.3 (`url`, `protocolVersion`, `x-ai37`) + `supportedInterfaces`, где
  JSON-RPC объявлен версиями `1.0` и `0.3`. Агент описывает карточку как раньше (`Ai37AgentCardInput`),
  интерфейсы хост строит сам.
- Клиент 0.3 ходит без `A2A-Version` и попадает в compat-слой SDK; когниция видит один и тот же
  `AgentInput`.
- Форма `input-required` уходит data-частью `{ a2ui: [...] }` в `status.message`, рядом с текстом паузы
  (канон A2A и расширения A2UI для A2A); в `metadata` задачи — `state`. Пока включён compat 0.3, та же
  форма лежит копией в артефакте `a2ui-<taskId>`: её читает relay 0.3. `extractA2ui` ищет форму в
  `status.message`, затем в артефакте, затем в `metadata.a2ui` (агенты на ts-host 0.1 и python-host).
- `createAgentHost({ legacyCompat: false })` выключает 0.3, убирает 0.3-интерфейс из карточки и копию
  формы в артефакте.

Звать другого агента — через relay и готовую фабрику клиентов (compat 0.3 на клиенте включён всегда:
агенты на старом хосте и внешние агенты пользователей могут жить на 0.3 годами):

```ts
import { createAi37ClientFactory, executeRemoteA2a } from "@ai37/agent-host/relay";

const client = await createAi37ClientFactory(fetchWithAuth).createFromUrl(agentBaseUrl);
const res = await executeRemoteA2a(client, { query, contextId, resumeTaskId });
// res.state: 'completed' | 'input-required' | 'failed' | 'message' (строки 0.3)
// res.staleResumeDropped: пауза устарела (нет задачи или она завершена), ход повторён новым диалогом
```

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
