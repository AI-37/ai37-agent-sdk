<!-- ai37:context:start (managed by doc-bot — do not edit inside) -->
# ai37-agent-sdk

Что это: SDK агентов AI37 — auth (JWKS), billing, A2A-forward user-JWT, AgentContext; две реализации (TS/Python), общий контракт; host-слой @ai37/agent-host.

Стек:
- TS: Node ≥ 22, npm, tsup
- Python: 3.11+, poetry, ruff, mypy, pytest
- contract/ (JSON Schema + feature-codes), кодоген scripts/codegen.mjs

Команды:
- install: npm i @ai37/agent-sdk | pip install ai37-agent-sdk
- build: make ts (TS build), make py (python build)
- test: make ts (npm test), make py (poetry run pytest), make verify
- lint: npm run lint (TS), poetry run ruff check .
- deploy: GitHub Actions publish-ts/python/ts-host/python-host (npm/PyPI)

Полная карточка — блок ai37:card в README
Архитектура экосистемы — репозиторий AI-37/docs (ecosystem/…)
Процедуры — скиллы /ai37
<!-- ai37:context:end -->
