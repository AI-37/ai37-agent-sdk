# Единые имена переменных окружения (WP0a)

Замороженный контракт. Используется агентами, оркестратором, billing-сервисом.

## Auth (JWKS)
```
AI37_OIDC_ISSUER      # https://<issuer>/
AI37_OIDC_JWKS_URL    # https://<issuer>/jwks/
AI37_OIDC_AUDIENCE    # <client-id>
AI37_AUTH_REQUIRED    # true | false (миграция; false = JWT необязателен, читается если есть)
AI37_AUTH_MODE        # jwks (прод/дефолт) | insecure-dev (обход подписи, claims из файла; только dev)
AI37_DEV_CLAIMS_FILE  # путь к JSON с claims — для AI37_AUTH_MODE=insecure-dev
```

## Billing
```
BILLING_MICROSERVICE_BASE_URL        # http(s)://billing...
BILLING_MICROSERVICE_APPS_AUTH_TOKEN # legacy apps-token (Bearer); в v1.2 forward user-JWT
BILLING_MODE                         # http (прод/дефолт) | fake (фикстуры, dev/тесты)
BILLING_IDENTITY_SOURCE              # jwt-claim | message (миграция; источник billing_org_id)
LLM_KEY_SOURCE                       # runtime-state | message (миграция; откуда брать llm_key)
```

## A2A
```
A2A_AUTH_MODE         # forward-user-jwt | delegated-token (миграция)
```

## Защита dev-режимов
`AI37_AUTH_MODE=insecure-dev` и `BILLING_MODE=fake` ДОЛЖНЫ отказывать при прод-признаках
(`NODE_ENV=production` / `ENV=prod` / боевой `AI37_OIDC_ISSUER`) и громко предупреждать. Никогда не
дефолт.
