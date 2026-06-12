# ai37-agent-sdk (Python)

SDK агентов экосистемы **AI37** (Python). Зеркало TS-пакета `@ai37/agent-sdk` (имена snake_case,
**синхронный** API). Модули: **auth** (JWKS-верификация user-JWT), **billing** (runtime state +
metered usage), **a2a** (forward user-JWT), **AgentContext** (sugar) и **testing kit**.

> Контракт (источник истины) — `../../contract/`. Спецификация — `docs/projects/ai37-agent-sdk/`.
> Host-слой (Express/FastAPI) в Python **не реализован** (пока не нужен).

## Быстрый старт

```python
from ai37_agent_sdk import AgentContext, AgentContextSettings, AuthSettings, BillingSettings

ctx = AgentContext.from_request(
    request_headers,
    AgentContextSettings(
        auth=AuthSettings(
            issuer="https://auth.dev.sp-ai.ru/application/o/sp-ai/",
            audience="sp-ai-web",
            jwks_url="https://auth.dev.sp-ai.ru/application/o/sp-ai/jwks/",
            required=True,
        ),
        billing=BillingSettings(base_url="http://billing-microservice:8000"),
    ),
)
state = ctx.assert_execution_allowed(feature=..., privilege=...)  # preflight
# LLM-агент:    api_key = ctx.litellm_key
# metered-агент: ctx.report_usage(transaction_id=task_id, code="lift_calculation", properties={...})
```

## Тестирование агентов без Authentik/billing

```python
from ai37_agent_sdk.testing import make_test_context, InMemoryBillingClient, fixtures

ctx = make_test_context(
    claims={"sub": "u1", "org_id": "u1", "billing_org_id": "org1", "app_id": "sp-ai"},
    billing=InMemoryBillingClient(runtime_state=fixtures.runtime_state.no_resources()),
)
# ctx.assert_execution_allowed(...) -> BillingExecutionDeniedError по фикстуре
```

## Разработка

```bash
poetry install --with dev
poetry run pytest
poetry run ruff check .
poetry run mypy src
```

Не реализовано (follow-up): CLI dev-серверы (`dev-jwks`/`dev-billing`), режимы
`AI37_AUTH_MODE=insecure-dev` / `BILLING_MODE=fake`. Основной testing kit (фейки/фикстуры/тест-токены)
— есть.
