from __future__ import annotations

import re
from typing import Any

_BEARER_RE = re.compile(r"^Bearer\s+(.+)$", re.IGNORECASE)


def extract_bearer(headers: Any) -> str | None:
    """Достаёт Bearer-токен из заголовков (dict, Mapping или объект с .get).

    Регистронезависимо по имени заголовка; значение-список → берётся первый элемент.
    """
    if headers is None:
        return None

    raw: Any = None
    getter = getattr(headers, "get", None)
    if callable(getter):
        # Headers-like (httpx.Headers, Starlette Headers, dict) — регистронезависимо у большинства.
        raw = getter("authorization")
        if raw is None and hasattr(headers, "items"):
            for key, value in headers.items():  # type: ignore[attr-defined]
                if str(key).lower() == "authorization":
                    raw = value
                    break
    if raw is None:
        return None
    if isinstance(raw, list | tuple):
        raw = raw[0] if raw else None
    if not isinstance(raw, str):
        return None

    match = _BEARER_RE.match(raw.strip())
    return match.group(1) if match else None
