# Changelog — ai37-agent-sdk (Python)

Формат: [Keep a Changelog](https://keepachangelog.com/). Версия — `pyproject.toml` этого пакета;
публикуется в PyPI независимо от TS-пакетов.

## [0.1.0a6] - 2026-08-08

### Added

- `active_payment_status: bool | None` в `BillingRuntimeState` (+ маппинг `from_api`): здоровье
  оплаты, резолвится billing-сервисом. `False` → терминальный провал платежа → доступ блокируется.
  Ортогонально `entitlement_status`.
- Причина отказа `PAYMENT_FAILED` (проверяется первой) в `BillingDenialReason`/`explain_denial`;
  `assert_execution_allowed` блокирует при `active_payment_status is False`. Хелпер `is_payment_blocked`.
- Единая карта текстов `BILLING_USER_MESSAGES` + `DEFAULT_BILLING_USER_MESSAGE` +
  `billing_user_message(reason_or_err)` — единый источник дружелюбного текста для агентов.
  `friendly_billing_message` — тонкая обёртка над ним.

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
