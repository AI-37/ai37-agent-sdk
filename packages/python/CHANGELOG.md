# Changelog — ai37-agent-sdk (Python)

Формат: [Keep a Changelog](https://keepachangelog.com/). Версия — `pyproject.toml` этого пакета;
публикуется в PyPI независимо от TS-пакетов.

## [0.1.0a0] - 2026-06-12

### Added
- Ядро SDK: auth (`JwksJwtVerifier` на PyJWT), billing, a2a (`build_a2a_auth_headers`,
  `A2A_PROTOCOL_VERSION`), `AgentContext`, testing kit (фейки, фикстуры,
  `create_test_keyset`/`make_test_context`).

### Deferred
- Python CLI (dev-серверы `dev-jwks`/`dev-billing`) и режимы `insecure-dev`/`fake` — follow-up.
