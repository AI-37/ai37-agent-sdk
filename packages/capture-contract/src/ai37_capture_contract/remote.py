"""Ответ рендерера вне кластера: снимки едут в теле, а не в бакете.

У рендерера на GPU-машине нет ключей бакета и не должно быть: ключи у кластера, а машина — чужое
железо. Поэтому он отдаёт PNG в ответе, а адаптер на стороне агента кладёт их в бакет, считает
`sha256` и дальше работает с обычным `CaptureResponse`. Ответ browser-worker это не меняет.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from ai37_capture_contract.models import ActionRecord, CaptureResponse, Clip, ScreenshotRole


class RemoteScreenshot(BaseModel):
    """Кадр с геометрией и байтами. Ключа, хэша и размера нет: их даёт бакет, а не рендерер."""

    role: ScreenshotRole
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    device_scale_factor: float = Field(ge=0.1)
    clip: Clip | None = None
    scroll_offset: int = Field(default=0, ge=0)
    png_base64: str = Field(min_length=1)


class RemoteCaptureResponse(CaptureResponse):
    """`CaptureResponse` со снимками в теле. Все остальные поля и их смысл — те же."""

    screenshots: list[RemoteScreenshot] = Field(default_factory=list)  # type: ignore[assignment]


class RemoteCaptureBatchResponse(BaseModel):
    """`CaptureBatchResponse` со снимками в теле.

    Тот же контракт порядка: ровно по одному результату на каждый элемент запроса и в том же
    порядке. «Строки без отчёта» нет — сбой карточки приезжает `ERROR` или `TIMEOUT` с `detail`.
    """

    results: list[RemoteCaptureResponse] = Field(default_factory=list)
    prepared: bool = True
    preparation: list[ActionRecord] = Field(default_factory=list)
    detail: str | None = None
    proxy: str = ""
