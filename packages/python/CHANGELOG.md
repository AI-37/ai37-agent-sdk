# Changelog — ai37-agent-sdk (Python)

Формат: [Keep a Changelog](https://keepachangelog.com/). Версия — `pyproject.toml` этого пакета;
публикуется в PyPI независимо от TS-пакетов.

## [0.1.0a18] - 2026-09-25

### Added

- Расширение agent card `showcase/v1` (`AI37_SHOWCASE_EXTENSION_URI`, `AgentShowcaseProfile`,
  `build_agent_showcase_extension` / `normalize_agent_showcase_profile` /
  `parse_agent_showcase_extension`) — парити с TS `0.1.0-alpha.26`. Витринные данные агента
  для каталога продукта; карточка без расширения валидна.

### Changed

- Нормализация витрины обрезает длинный текст и отбрасывает битые элементы вместо отказа от
  карточки; обязательны только `title` и `summary`. `compact_text` переехал в `a2a/text.py`
  и общий для обоих расширений.

## [0.1.0a17] - 2026-09-24

### Removed

- Фичи `hvac-heat-loss` и `hvac-air-exchange` из `BillingFeatureCode` (парити с TS
  `0.1.0-alpha.25`). Скиллы агента ОВиК разделяются привилегиями `hvac-heat-loss-allowed` /
  `hvac-air-exchange-allowed` внутри единственной фичи `hvac-calc-agent` — по образцу
  `minstroy-agent`.

## [0.1.0a16] - 2026-09-24

### Added

- Per-skill коды агента ОВиК: фичи `hvac-heat-loss` / `hvac-air-exchange` и привилегии
  `hvac-heat-loss-allowed` / `hvac-air-exchange-allowed` (парити с TS `0.1.0-alpha.24`).
  Агентский уровень `hvac-calc-agent` / `hvac-calc-allowed` остаётся фолбэк-гейтом.

## [0.1.0a15] - 2026-09-23

### Added

- `JwksJwtVerifier(required_claims=...)` (парити с TS `0.1.0-alpha.23`) — какие claim обязаны
  присутствовать строкой. Дефолт `("sub", "org_id", "billing_org_id")`, то есть поведение
  существующих верификаторов не меняется. Набор понадобился платформенному оператору: организации
  у него нет, и требовать с него `org_id` значило бы изготавливать фиктивную организацию ради
  прохода верификатора.
- Подпакет `policy`: `parse_policy_state` / `read_policy_state` / `PolicyStateOptions` (парити с TS
  `0.1.0-alpha.23`) — общий разбор политики, объявленной переменной окружения. Отсутствие, пустая
  строка и нераспознанное сводятся к одному исходу, а набор состояний и дефолт передаёт вызывающий.

## [0.1.0a14] - 2026-09-23

### Added

- Фича `daylight-calc-agent` и привилегия `daylight-calc-allowed` (парити с TS
  `0.1.0-alpha.22`) — биллинг агента расчёта КЕО (план docs#361).

## [0.1.0a13] - 2026-09-23

### Added

- Код фичи `org-limits` и привилегии `max-users` / `max-api-keys` в `BillingFeatureCode` /
  `BillingPrivilegeCode` (парити с TS `0.1.0-alpha.21`) — источник истины для тарифных лимитов
  на участников организации и активные API-ключи (план `spai-org-limits-and-ip-tariff.md`, §3.6).

## [0.1.0a12] - 2026-09-12

### Added

- Привилегия `minstroy-price-monitoring` (парити с TS `0.1.0-alpha.20`) — мониторинг цен агента
  Минстроя.

## [0.1.0a11] - 2026-08-27

### Added

- Фича `hvac-calc-agent` и привилегия `hvac-calc-allowed` (парити с TS `0.1.0-alpha.19`) —
  биллинг агента расчёта ОВиК.

## [0.1.0a10] - 2026-08-20

### Added

- Фича `pdai-site-check` и привилегия `pdai-site-check-allowed` (парити с TS `0.1.0-alpha.18`) —
  проверка сайта на соответствие требованиям (PD-AI).

## [0.1.0a9] - 2026-08-20

### Added

- Фичи `pdai-doc-152fz` / `pdai-doc-187fz` и привилегии `pdai-doc-152fz-allowed` /
  `pdai-doc-187fz-allowed` (парити с TS `0.1.0-alpha.17`) — генерация документов PD-AI
  по 152-ФЗ и 187-ФЗ.

## [0.1.0a8] - 2026-08-13

### Changed

- JWT-верификатор мемоизируется между запросами (`context.py`, парити с TS `0.1.0-alpha.16`):
  один экземпляр на процесс на каждый уникальный состав auth-настроек. Долгоживущий верификатор
  убирает поход за JWKS на каждый запрос. Несериализуемые конфиги (собственный набор ключей или
  резолвер ключей в `issuers[]`) не кэшируются и собираются заново — это тестовые и инъекционные
  пути, в сеть они не ходят.

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
