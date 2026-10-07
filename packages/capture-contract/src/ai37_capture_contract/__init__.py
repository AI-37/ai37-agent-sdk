"""Контракт захвата карточки товара для рендереров мониторинга цен AI37.

Модели запроса и ответа `/capture-batch`, `/health` рендерера, коды причин и сканер цен в DOM.
"""

from ai37_capture_contract.health import (
    ExitHealth,
    RendererCapacity,
    RendererHealth,
    RendererKind,
    RendererState,
)
from ai37_capture_contract.models import (
    REASON_DOMAIN_COOLDOWN,
    REASON_EXIT_BLOCKED,
    REASON_HOME_UNREACHABLE,
    REASON_HOST_NOT_ALLOWED,
    REASON_NOT_FOUND,
    REASON_REGION_MISMATCH,
    REASON_RENDERER_UNAVAILABLE,
    REASON_SITE_BLOCKED,
    ActionRecord,
    CaptureBatchItem,
    CaptureBatchRequest,
    CaptureBatchResponse,
    CaptureEnvironment,
    CaptureRequest,
    CaptureResponse,
    CaptureStatus,
    Clip,
    PriceHint,
    Screenshot,
    ScreenshotRole,
)
from ai37_capture_contract.price_hints import PRICE_HINTS_JS
from ai37_capture_contract.remote import RemoteCaptureBatchResponse, RemoteCaptureResponse, RemoteScreenshot

__all__ = [
    "PRICE_HINTS_JS",
    "REASON_DOMAIN_COOLDOWN",
    "REASON_EXIT_BLOCKED",
    "REASON_HOME_UNREACHABLE",
    "REASON_HOST_NOT_ALLOWED",
    "REASON_NOT_FOUND",
    "REASON_REGION_MISMATCH",
    "REASON_RENDERER_UNAVAILABLE",
    "REASON_SITE_BLOCKED",
    "ActionRecord",
    "CaptureBatchItem",
    "CaptureBatchRequest",
    "CaptureBatchResponse",
    "CaptureEnvironment",
    "CaptureRequest",
    "CaptureResponse",
    "CaptureStatus",
    "Clip",
    "ExitHealth",
    "PriceHint",
    "RemoteCaptureBatchResponse",
    "RemoteCaptureResponse",
    "RemoteScreenshot",
    "RendererCapacity",
    "RendererHealth",
    "RendererKind",
    "RendererState",
    "Screenshot",
    "ScreenshotRole",
]
