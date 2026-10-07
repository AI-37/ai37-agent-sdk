# Changelog — ai37-capture-contract

## [0.1.0] - 2026-10-07

Первая публикация. Контракт захвата карточки товара для рендереров мониторинга цен: модели
`CaptureBatchRequest` / `CaptureBatchResponse` и `CaptureResponse` browser-worker, `Remote*` для
рендерера вне кластера (PNG в теле ответа), `RendererHealth`, коды причин `REASON_*`
(в том числе `NOT_FOUND`, `SITE_BLOCKED`, `RENDERER_UNAVAILABLE`, `HOME_UNREACHABLE`,
`HOST_NOT_ALLOWED`), сканер цен в DOM `PRICE_HINTS_JS`.

Перенесён из `AI-37/minstroy` (`packages/capture-contract`, коммит `73dc24e`) без изменений моделей:
контракт общий для minstroy и `AI-37/website-scraper`, публикуется отсюда, потребители берут его
из `pypi.app.sp-ai.ru` по версии.
