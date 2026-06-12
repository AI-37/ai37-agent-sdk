# ai37-agent-sdk

SDK для агентов экосистемы **AI37**: **auth** (JWKS-верификация user-JWT Authentik), **billing**
(runtime state + metered usage через billing-microservice), **a2a** (forward user-JWT),
**AgentContext** (sugar) и **testing kit** (фейки, фикстуры, dev-серверы). Эволюция
`ai37-billing-apps-client`.

Монорепо, две реализации с общим контрактом:

| Пакет | Реестр | Путь |
|---|---|---|
| `@ai37/agent-sdk` | npm | `packages/ts` |
| `ai37-agent-sdk` | PyPI | `packages/python` |

- **Контракт (источник истины):** [`contract/`](contract/) — claims, runtime state, feature-codes,
  webhook, env. Кодоген `codes` в оба пакета: `make codegen`.
- **Спецификация и API:** см. экосистемную документацию `docs/projects/ai37-agent-sdk/`
  ([README](../docs/projects/ai37-agent-sdk/README.md),
  [TESTING](../docs/projects/ai37-agent-sdk/TESTING.md)) и
  [WP0-бриф](../docs/projects/ai37-agent-sdk/WP0-subagent-brief.md).

## Быстрый старт (агент)

```ts
import { AgentContext } from "@ai37/agent-sdk";
const ctx = await AgentContext.fromRequest(headers, settings);
const state = await ctx.assertExecutionAllowed({ feature, privilege }); // preflight
// LLM-агент: const apiKey = state.litellmKey;
// metered-агент: await ctx.reportUsage({ transactionId: task.id, code, properties });
```
```python
from ai37_agent_sdk import AgentContext
ctx = AgentContext.from_request(headers, settings)
state = ctx.assert_execution_allowed(feature=..., privilege=...)
```

## Тестирование агентов без Authentik/billing

`@ai37/agent-sdk/testing` / `ai37_agent_sdk.testing`: `FakeJwtVerifier`, `InMemoryBillingClient`,
фикстуры runtime state, CLI `dev-jwks`/`make-token`/`dev-billing`. См.
[TESTING.md](../docs/projects/ai37-agent-sdk/TESTING.md).

## Разработка

```bash
make codegen     # contract/feature-codes.json → codes.ts + codes.py
make ts          # сборка/тесты TS-пакета
make py          # сборка/тесты Python-пакета
make verify      # codegen-парити + оба пакета
```

Статус: **0.1.0-alpha** (в разработке, WP0a+WP0b).
