# Changelog

Формат: [Keep a Changelog](https://keepachangelog.com/). Версионирование — общее для обоих пакетов
(файл `VERSION`).

## [Unreleased]

### Added
- WP0a: контракты `contract/` (claims, runtime state с `llmKey`, feature-codes, env).
- WP0b: TS-пакет `@ai37/agent-sdk` — billing (runtime state + `llmKey`),
  auth (`JwtVerifier` на jose), a2a (`forwardAuthFetch`), `AgentContext`, testing kit (фейки,
  фикстуры, `createTestKeyset`, `makeTestContext`), CLI (`dev-jwks`/`make-token`/`dev-billing`).
  35 тестов, tsc clean, сборка `index` + `./testing` + `cli`.
- Python-пакет `ai37-agent-sdk` — auth (`JwksJwtVerifier` на PyJWT), billing, a2a, `AgentContext`,
  testing kit (фейки, фикстуры, `create_test_keyset`/`make_test_context`). 23 теста, ruff/mypy clean.

### Deferred
- Python CLI (dev-серверы `dev-jwks`/`dev-billing`) и режимы `insecure-dev`/`fake` — follow-up.

## [0.1.0-alpha.0] - 2026-06-12
- Инициализация монорепо (Python + TS), скелет, кодоген контракта.

## [0.1.0-alpha.2] - 2026-06-14
- Использование каноничного рендеринга A2UI-компонентов
