# @ai37/agent-host

HTTP-хост для **агентов** экосистемы AI37: `createAgentHost(...)` собирает Express-приложение с
нативным **A2A 1.0** (JSON-RPC), **AG-UI** (SSE), JWT-guard и health/version — поверх
[`@ai37/agent-sdk`](https://www.npmjs.com/package/@ai37/agent-sdk).
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
  card, // AgentCard (@a2a-js/sdk)
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

Host использует канонические типы и серверный контракт `@a2a-js/sdk` 1.0. Опциональный
`legacyCompat` (по умолчанию включён) существует только как официальный compatibility edge для
старых A2A-клиентов; доменная логика и task-store всегда работают с моделью 1.0.

## Контракт

Агент реализует `AgentHandler.run(req)` — получает нормализованный `AgentInput` + verified `AgentContext`,
возвращает `AgentResult` (`status` + опц. `a2ui`/`message`/`followup`/`result`/`state`). Host не содержит
доменной логики.

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
`input.taskState`. По умолчанию хранилище — `InMemoryTaskStore` (per-process, только для локальной
разработки). Для production используйте экспортируемый `RedisTaskStore`: он реализует A2A 1.0
`TaskStore`, изолирует ключи по tenant и authenticated user и поддерживает TTL.

```ts
import { createAgentHost, RedisTaskStore } from "@ai37/agent-host";

const taskStore = new RedisTaskStore({
  url: process.env.REDIS_URL!,
  keyPrefix: "my-agent:a2a:task:",
  ttlSeconds: 7 * 24 * 60 * 60,
});

createAgentHost({ card, handler, agentContext, taskStore });
```

## Установка

```bash
npm i @ai37/agent-host @ai37/agent-sdk
```

`@ai37/agent-sdk` — peer-зависимость (auth + billing). Лицензия: Apache-2.0.
