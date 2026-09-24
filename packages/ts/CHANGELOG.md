# Changelog — @ai37/agent-sdk

Формат: [Keep a Changelog](https://keepachangelog.com/). Версия — `package.json` этого пакета;
публикуется независимо от `@ai37/agent-host` и Python-пакета.

## [0.1.0-alpha.25] - 2026-09-24

### Removed

- Фичи `hvac-heat-loss` и `hvac-air-exchange` из `BillingFeatureCode` (заведены в
  `0.1.0-alpha.24`, потребителей не успели получить). Скиллы агента ОВиК разделяются
  привилегиями `hvac-heat-loss-allowed` / `hvac-air-exchange-allowed` ВНУТРИ единственной
  фичи `hvac-calc-agent` — так же, как `minstroy-check-inn` / `minstroy-price-monitoring`
  живут внутри `minstroy-agent`. Фича = продаваемый агент, привилегия = состав скиллов;
  отдельная фича на скилл заставляла бы организацию покупать один агент трижды.

## [0.1.0-alpha.24] - 2026-09-24

### Added

- Per-skill коды агента ОВиК: фичи `hvac-heat-loss` / `hvac-air-exchange` и привилегии
  `hvac-heat-loss-allowed` / `hvac-air-exchange-allowed` в `BillingFeatureCode` /
  `BillingPrivilegeCode` (ревью docs#177, канон `ecosystem/v2/04-a2a-conventions.md`,
  раздел «Per-skill биллинг»). Агентский уровень `hvac-calc-agent` / `hvac-calc-allowed`
  остаётся фолбэк-гейтом — изменение аддитивное.

## [0.1.0-alpha.23] - 2026-09-23

### Added

- `JwtVerifierOptions.requiredClaims` (и то же поле у `MultiIssuerVerifierOptions`) — какие claim
  обязаны присутствовать строкой. Дефолт `['sub','org_id','billing_org_id']`, то есть поведение
  существующих верификаторов не меняется. Набор понадобился платформенному оператору: организации
  у него нет, и требовать с него `org_id` значило бы изготавливать фиктивную организацию ради
  прохода верификатора.
- Модуль `policy`: `parsePolicyState` / `readPolicyState` — общий разбор политики, объявленной
  переменной окружения. Общее у таких гейтов не состояния, а разбор: отсутствие, пустая строка и
  нераспознанное сводятся к одному исходу, а набор состояний и дефолт передаёт вызывающий. Пустую
  строку обязан обрабатывать разбор, а не схема окружения: сервисы читают `process.env` напрямую,
  и `''` из ConfigMap до дефолта схемы не доезжает.

## [0.1.0-alpha.22] - 2026-09-23

### Added

- Фича `daylight-calc-agent` и привилегия `daylight-calc-allowed` в `BillingFeatureCode` /
  `BillingPrivilegeCode` — биллинг агента расчёта КЕО (план docs#361).

## [0.1.0-alpha.21] - 2026-09-23

### Added

- Код фичи `org-limits` и привилегии `max-users` / `max-api-keys` в `BillingFeatureCode` /
  `BillingPrivilegeCode` — источник истины для тарифных лимитов на участников организации и
  активные API-ключи (план `spai-org-limits-and-ip-tariff.md`, §3.6). Кода, который читает
  константы, в SDK нет: серверный гейт делается отдельно, значения по планам — в `infra`.

## [0.1.0-alpha.20] - 2026-09-12

### Added

- Привилегия `minstroy-price-monitoring` в `BillingPrivilegeCode` — мониторинг цен агента Минстроя.

## [0.1.0-alpha.19] - 2026-08-27

### Added

- Фича `hvac-calc-agent` и привилегия `hvac-calc-allowed` — биллинг агента расчёта ОВиК.

## [0.1.0-alpha.18] - 2026-08-20

### Added

- Фича `pdai-site-check` и привилегия `pdai-site-check-allowed` — проверка сайта на соответствие
  требованиям (PD-AI).

## [0.1.0-alpha.17] - 2026-08-20

### Added

- Фичи `pdai-doc-152fz` / `pdai-doc-187fz` и привилегии `pdai-doc-152fz-allowed` /
  `pdai-doc-187fz-allowed` — генерация документов PD-AI по 152-ФЗ и 187-ФЗ.

## [0.1.0-alpha.16] - 2026-08-13

### Changed

- JWT-верификатор мемоизируется между запросами (`auth/verifierCache.ts`): один экземпляр на
  процесс на каждый уникальный состав auth-настроек, ключ кэша — детерминированный JSON из
  `issuer`/`audience`/`jwksUrl`/`issuers[]`/`introspection`/`leeway`. JWKS-кэш `jose` живёт в
  замыкании key-резолвера, поэтому долгоживущий верификатор убирает поход за JWKS на каждый
  запрос. Несериализуемые конфиги (`jwks`-набор или `keyResolver` в `issuers[]`) не кэшируются
  и собираются заново — это тестовые и инъекционные пути, в сеть они не ходят.

## [0.1.0-alpha.15] - 2026-08-10

### Added

- Интент `document_generation` в `AI37_ROUTING_INTENTS` и routing/v1 schema — генерация документов
  по исходным данным пользователя (первый потребитель — `pdai-doc-gen-agent`, документы 152-ФЗ/187-ФЗ).
  Изменение аддитивное: существующие профили карточек остаются валидными.

## [0.1.0-alpha.14] - 2026-08-09

### Added

- Причина отказа `PAYMENT_FAILED` в `BillingDenialReason`. `explainDenial` теперь маппит значение
  `entitlementStatus` в причину: `payment_failed` → `PAYMENT_FAILED`, `no_resources` → `NO_TOKENS`,
  иное `!== 'active'` → `ENTITLEMENT_INACTIVE`. Гейт `assertExecutionAllowed` НЕ менялся
  (`entitlementStatus !== 'active'` уже блокирует провал платежа) — billing кодирует причину в статусе.
- Единая карта текстов `BILLING_USER_MESSAGES` + `DEFAULT_BILLING_USER_MESSAGE` +
  `billingUserMessage(reasonOrErr)` — единый источник дружелюбного текста для агентов
  (в т.ч. для их preflight-веток). `friendlyBillingMessage` — тонкая обёртка над ним.
  Текст `PAYMENT_FAILED` → «Платёж не прошёл…».

## [0.1.0-alpha.13] - 2026-08-01

### Removed

- `workflow_continue` из `AI37_ROUTING_INTENTS` и routing/v1 schema. Продолжение HITL/wizard —
  `mode=continuation` оркестратора, не intent карточки. Карточка с этим значением невалидна
  (parse fail-open → профиль отсутствует).

## [0.1.0-alpha.11] - 2026-07-29

### Added

- Единый additive-контракт Agent Card routing-extension: types, bounded
  `buildAgentRoutingExtension` и fail-open `parseAgentRoutingExtension`.
- `AI37_ROUTING_EXTENSION_URI` — versioned идентификатор extension, не HTTP endpoint.
  Изменений версии A2A и сетевых обращений к URI нет.

## [0.1.0-alpha.12]

### Added

- Публикация routing exports в npm-пакете `@ai37/agent-sdk`, чтобы consumer’ы могли импортировать
  `AI37_ROUTING_EXTENSION_URI` и `buildAgentRoutingExtension` из published package.

## [0.1.0-alpha.10] - 2026-07-19

### Added
- Multi-user организации (амендмент v2): тип `OrgRole` (`OWNER | EDITOR | USER`) и опциональный
  claim `Claims.org_role`. Верификатор и обязательные claims (`sub`/`org_id`/`billing_org_id`)
  НЕ меняются — `org_role` едет как дополнительный claim.
- `AgentContext.orgId`, `AgentContext.role` (отсутствующий claim → `USER`, least-privilege) и
  `AgentContext.assertRole(min)` — гейт по роли для EDITOR+ инструментов; при недостатке роли
  бросает `AuthError` с новым кодом `forbidden_role` (семантика 403, не 401). Порядок:
  `USER < EDITOR < OWNER`.

## [0.1.0-alpha.6] - 2026-06-24

### Fixed
- Billing usage-ingest (`POST /api/v1/events`) уходил под форварднутым user-JWT и получал
  `HTTP 401 "invalid app auth token"`: эндпоинт принимает только apps-token. Токены разведены
  по эндпоинтам — `/state` под `authToken` (форвард JWT, anti-IDOR по `billing_org_id`),
  usage-ingest под новым обязательным `usageIngestToken` (apps-token). `AgentContext.fromRequest`
  прокидывает `settings.billing.appsAuthToken` в `usageIngestToken`.

### Changed
- `BillingClientOptions`: добавлено обязательное поле `usageIngestToken` (breaking для прямых
  потребителей `createBillingClient`). `validateOptions` требует непустое значение.

## [0.1.0-alpha.3] - 2026-06-17

### Added
- `output-modes.ts` — канон content-negotiation вывода (РЕШЕНИЕ 10): MIME-константы
  (`OUTPUT_MODE_TEXT`/`_MARKDOWN`/`_MARKDOWN_SPAI`/`_A2UI_BASE`/`_A2UI_AI37`), `A2UI_MODE_CATALOG`,
  `negotiateOutput`, `clientAcceptsA2ui`, `filterA2uiComponents`, тип `OutputNegotiation`.
- Зависимость `@ai37/a2ui-catalog-schemas@^0.3.0` — id каталогов берём из лёгкого subpath
  `/constants` (без zod-схем барреля).

## [0.1.0-alpha.2] - 2026-06-16

### Added
- Ядро SDK: billing (runtime state + `llmKey`), auth (`JwtVerifier` на jose), a2a
  (`forwardAuthFetch`, `A2A_PROTOCOL_VERSION`), `AgentContext`, testing kit (фейки, фикстуры,
  `createTestKeyset`/`makeTestContext`), CLI (`dev-jwks`/`make-token`/`dev-billing`).
- Dev-режим (`insecure-dev` + fake billing) через env, fail-closed в проде; экспорт `./dev`.

## [0.1.0-alpha.0] - 2026-06-12

### Added
- Инициализация монорепо: контракты `contract/` (claims, runtime state с `llmKey`, feature-codes,
  env), скелет, кодоген контракта.
