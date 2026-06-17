# Changelog — @ai37/agent-sdk

Формат: [Keep a Changelog](https://keepachangelog.com/). Версия — `package.json` этого пакета;
публикуется независимо от `@ai37/agent-host` и Python-пакета.

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
