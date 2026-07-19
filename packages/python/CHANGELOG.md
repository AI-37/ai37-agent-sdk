# Changelog — ai37-agent-sdk (Python)

Формат: [Keep a Changelog](https://keepachangelog.com/). Версия — `pyproject.toml` этого пакета;
публикуется в PyPI независимо от TS-пакетов.

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
