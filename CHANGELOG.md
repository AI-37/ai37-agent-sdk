# Changelog

Формат: [Keep a Changelog](https://keepachangelog.com/). Версионирование — общее для обоих пакетов
(файл `VERSION`).

## [Unreleased]

### Added
- WP0a: контракты `contract/` (claims, runtime state с `litellmKey`, feature-codes, webhook, env).
- WP0b: TS-пакет `@ai37/agent-sdk` — billing (перенос из `ai37-billing-apps-client` + `litellmKey`),
  auth (`JwtVerifier` на jose), a2a (`forwardAuthFetch`), `AgentContext`, testing kit (фейки,
  фикстуры, `createTestKeyset`, `makeTestContext`), CLI (`dev-jwks`/`make-token`/`dev-billing`).
  35 тестов, tsc clean, сборка `index` + `./testing` + `cli`.

### Deferred
- Python-пакет `ai37-agent-sdk` намеренно отложен (вернёмся позже). Поддерживается только
  сгенерированный `codes.py` (синхрон с контрактом).

## [0.1.0-alpha.0] - 2026-06-12
- Инициализация монорепо (Python + TS), скелет, кодоген контракта.
