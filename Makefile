.PHONY: codegen ts py verify clean

# Кодоген кодов фич/привилегий из contract/ в оба пакета
codegen:
	node scripts/codegen.mjs

# TS-пакет: линт + тесты + сборка
ts:
	cd packages/ts && npm ci && npm run lint && npm run test && npm run build

# Python-пакет: линт + типы + тесты
py:
	cd packages/python && poetry install --with dev && poetry run ruff check . && poetry run mypy src && poetry run pytest

# Полная проверка: кодоген-парити + TS-пакет.
# Python-пакет намеренно отложен (codes.py всё равно держим в синхроне с контрактом).
verify: codegen
	@git diff --exit-code -- packages/ts/src/codes.ts packages/python/src/ai37_agent_sdk/codes.py \
		|| (echo "codes.ts/codes.py не соответствуют contract/ — запусти make codegen и закоммить" && exit 1)
	$(MAKE) ts
	@echo "verify: OK (TS). Python-пакет отложен — см. README."

clean:
	rm -rf packages/ts/dist packages/ts/node_modules packages/python/dist-python
