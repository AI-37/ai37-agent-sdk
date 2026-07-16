from __future__ import annotations

import json
import re
from typing import Any

import httpx

from .errors import BillingConfigurationError, BillingRequestError


def normalize_billing_base_url(raw: str) -> str:
    """Убирает хвостовые слэши и суффикс ``/api/vN`` (как TS normalizeBillingBaseUrl)."""
    s = re.sub(r"/+$", "", raw)
    s = re.sub(r"/api/v\d+$", "", s)
    return s


def read_response_body(response: httpx.Response) -> Any:
    text = response.text
    if not text.strip():
        return "(empty body)"
    try:
        return json.loads(text)
    except ValueError:
        return text


def format_error_body(body: Any) -> str:
    if isinstance(body, str):
        return body
    try:
        return json.dumps(body)
    except (TypeError, ValueError):
        return str(body)


def ensure_ok(response: httpx.Response, message_prefix: str) -> httpx.Response:
    if response.is_success:
        return response
    body = read_response_body(response)
    raise BillingRequestError(
        f"{message_prefix}: HTTP {response.status_code} {format_error_body(body)}",
        response.status_code,
        body,
    )


def validate_options(
    *,
    base_url: str,
    auth_token: str,
    usage_ingest_token: str,
    runtime_state_cache_ttl_ms: float,
) -> None:
    if not base_url.strip():
        raise BillingConfigurationError("Billing client base_url is required")
    if not auth_token.strip():
        raise BillingConfigurationError("Billing client auth_token is required")
    if not usage_ingest_token.strip():
        raise BillingConfigurationError("Billing client usage_ingest_token is required")
    if runtime_state_cache_ttl_ms < 0:
        raise BillingConfigurationError(
            "Billing client runtime_state_cache_ttl_ms must be >= 0"
        )
