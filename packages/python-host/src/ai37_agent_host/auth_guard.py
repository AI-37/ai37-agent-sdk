"""JWT-guard как чистый ASGI-middleware — порт ``ts-host/src/auth-guard.ts``.

Пишем pure-ASGI (НЕ ``BaseHTTPMiddleware``): downstream вызывается в ТОЙ ЖЕ задаче, поэтому
ALS-scope (``contextvars``) доезжает до executor'а ``a2a-sdk``. Базовый SDK синхронный →
``AgentContext.from_request`` гоняем через ``anyio.to_thread``, чтобы не блокировать event-loop.

``acceptedOutputModes``/``supportedCatalogIds`` в отличие от TS здесь НЕ парсим из тела:
executor берёт их нативно из ``RequestContext.configuration`` / ``message.metadata``.
"""

from __future__ import annotations

import json
from typing import Any

import anyio
from ai37_agent_sdk import AgentContext, AgentContextSettings, AuthError, extract_bearer

from .als import HostScope, reset_scope, set_scope


class AuthGuardMiddleware:
    """ASGI-middleware: verified AgentContext из заголовков → ALS-scope; 401 при required."""

    def __init__(
        self,
        app: Any,
        *,
        settings: AgentContextSettings,
        required: bool,
        guarded_prefixes: list[str],
        overrides: dict[str, Any] | None = None,
    ) -> None:
        self.app = app
        self._settings = settings
        self._required = required
        self._prefixes = tuple(guarded_prefixes)
        self._overrides = overrides or {}

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http" or not self._is_guarded(scope.get("path", "")):
            await self.app(scope, receive, send)
            return

        headers = _headers_dict(scope)
        bearer = extract_bearer(headers)
        ctx: AgentContext | None = None
        try:
            ctx = await anyio.to_thread.run_sync(self._build_ctx, headers)
        except AuthError as exc:
            if self._required:
                await _send_unauthorized(send, str(exc))
                return
            # required=false → пропускаем без ctx (миграция).

        token = set_scope(HostScope(ctx=ctx, bearer=bearer))
        try:
            await self.app(scope, receive, send)
        finally:
            reset_scope(token)

    def _build_ctx(self, headers: dict[str, str]) -> AgentContext:
        return AgentContext.from_request(headers, self._settings, **self._overrides)

    def _is_guarded(self, path: str) -> bool:
        return any(path.startswith(prefix) for prefix in self._prefixes)


def _headers_dict(scope: dict[str, Any]) -> dict[str, str]:
    return {
        key.decode("latin-1").lower(): value.decode("latin-1")
        for key, value in scope.get("headers", [])
    }


async def _send_unauthorized(send: Any, detail: str) -> None:
    body = json.dumps({"error": "unauthorized", "detail": detail}).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": 401,
            "headers": [(b"content-type", b"application/json")],
        }
    )
    await send({"type": "http.response.body", "body": body})
