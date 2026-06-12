# Контракт webhook: Authentik `user.created` → billing-microservice

Замороженный контракт (WP0a). Authentik по событию `user.created` шлёт webhook в
billing-microservice (в v1.2 — вместо sync-service), который провиженит customer в Lago + ключ
LiteLLM и возвращает привязку.

## Endpoint

```
POST /webhook/authentik/user-created
Auth: X-API-Key: <BILLING_AUTHENTIK__WEBHOOK_KEY>
Content-Type: application/json
```

## Request

```jsonc
{
  "uuid": "2dbfac5e-1111-4222-8333-1b89f5f6f1d2",  // = org_id (Authentik user uuid)
  "username": "jane.doe",
  "email": "jane@example.com",
  "name": "Jane Doe",
  "force": false,        // опц. — переинициализировать
  "plan_code": ""        // опц. — план по умолчанию
}
```

## Response (200)

```jsonc
{
  "org_id": "2dbfac5e-1111-4222-8333-1b89f5f6f1d2",
  "billing_org_id": "<lago customer id>",
  "litellm_key": "sk-...",
  "provisioning_status": "ready"   // ready | partial | pending
}
```

## Семантика

- Идемпотентно по `org_id` (повтор не плодит customer/ключи; статусы Lago 409/422 = успех).
- billing-microservice после провижининга записывает `billing_org_id` в атрибут пользователя
  Authentik (для claims) — отдельный исходящий вызов Authentik API.
- `litellm_key` далее отдаётся агентам **внутри runtime state** (не в JWT). См.
  `billing-runtime-state.schema.json`.

> Реализация — WP2 ([ecosystem/v1.2/05-sync-service-merge.md]). SDK сам webhook не вызывает; контракт
> здесь — для согласованности indexer/infra/billing-microservice.
