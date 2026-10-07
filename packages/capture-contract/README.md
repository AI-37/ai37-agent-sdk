# ai37-capture-contract

Контракт захвата карточки товара для рендереров мониторинга цен Минстроя: модели запроса и ответа
`POST /capture-batch`, `GET /health` рендерера, коды причин `REASON_*` и сканер цен в DOM
`PRICE_HINTS_JS`.

Источник правды — этот пакет в репозитории `AI-37/ai37-agent-sdk`. Потребители — browser-worker
minstroy и рендереры вне кластера (`AI-37/website-scraper`) — берут его версией из приватного индекса
`pypi.app.sp-ai.ru`, path-зависимостей нет: правка контракта = бамп версии + публикация отсюда.

| Модуль | Что |
|---|---|
| `models` | `CaptureBatchRequest` → `CaptureBatchResponse` browser-worker: снимки в бакете, в ответе ключи и `sha256` |
| `remote` | `RemoteCaptureBatchResponse` рендерера вне кластера: PNG в теле (`png_base64`), в бакет их кладёт агент |
| `health` | `RendererHealth` — `/health` обоих видов рендереров |
| `price_hints` | `PRICE_HINTS_JS` — строка для `page.evaluate`, возвращает `{hints, title_bottom}` |

Порядок ответов — часть контракта: ровно по одному результату на каждый элемент запроса и в том же
порядке.

## Версии

Любое изменение моделей — бамп `version` в `pyproject.toml` и запись в `CHANGELOG.md`. Публикация —
workflow `publish-capture-contract.yml` через `workflow_dispatch`, как у остальных пакетов монорепо; уже
опубликованная версия повторно не принимается.

## Разработка

```sh
cd packages/capture-contract
poetry install
poetry run pytest && poetry run mypy src && poetry run ruff check .
```
