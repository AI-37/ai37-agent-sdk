# Changelog — ai37-agent-sdk (Python)

Формат: [Keep a Changelog](https://keepachangelog.com/). Версия — `pyproject.toml` этого пакета;
публикуется в PyPI независимо от TS-пакетов.

## [0.1.0a7] - 2026-08-10

### Added

- Интент `document_generation` в `AI37_ROUTING_INTENTS` и routing/v1 schema (парити с TS
  `0.1.0-alpha.15`). Изменение аддитивное: существующие профили карточек остаются валидными.

## [0.1.0a6] - 2026-08-09

### Added

- Причина отказа `PAYMENT_FAILED` в `BillingDenialReason`. `explain_denial` маппит значение
  `entitlement_status` в причину: `payment_failed` → `PAYMENT_FAILED`, `no_resources` → `NO_TOKENS`,
  иное `!= 'active'` → `ENTITLEMENT_INACTIVE`. Гейт `assert_execution_allowed` НЕ менялся
  (`entitlement_status != 'active'` уже блокирует провал платежа) — billing кодирует причину в статусе.
- Единая карта текстов `BILLING_USER_MESSAGES` + `DEFAULT_BILLING_USER_MESSAGE` +
  `billing_user_message(reason_or_err)` — единый источник дружелюбного текста для агентов.
  `friendly_billing_message` — тонкая обёртка над ним. Текст `PAYMENT_FAILED` → «Платёж не прошёл…».

## [0.1.0a5] - 2026-08-01

### Removed

- `workflow_continue` из канонического набора intents. Continuation — mode оркестратора;
  карточка с этим значением невалидна (parse → None).

## [0.1.0a4] - 2026-07-29

### Added

- Python parity для Agent Card routing-extension: общий набор intents, bounded builder и
  fail-open parser. URI — идентификатор контракта, не HTTP endpoint.

## [0.1.0a3] - 2026-07-19

### Added
- Multi-user организации (амендмент v2): `OrgRole` (`OWNER | EDITOR | USER`) и опциональный
  claim `Claims.org_role`. Верификатор и обязательные claims не меняются.
- `AgentContext.org_id`, `AgentContext.role` (отсутствующий claim → `USER`) и
  `AgentContext.assert_role(min)` — гейт по роли; при недостатке роли бросает `AuthError` с
  новым кодом `forbidden_role` (семантика 403). Порядок: `USER < EDITOR < OWNER`.

## [0.1.0a0] - 2026-06-12

### Added
- Ядро SDK: auth (`JwksJwtVerifier` на PyJWT), billing, a2a (`build_a2a_auth_headers`,
  `A2A_PROTOCOL_VERSION`), `AgentContext`, testing kit (фейки, фикстуры,
  `create_test_keyset`/`make_test_context`).

### Deferred
- Python CLI (dev-серверы `dev-jwks`/`dev-billing`) и режимы `insecure-dev`/`fake` — follow-up.
