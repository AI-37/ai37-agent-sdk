"""MCP challenge-guard как чистый ASGI-middleware — порт ``ts-host/src/mcp/challenge-guard.ts``.

Отличие от :class:`AuthGuardMiddleware` (A2A/AG-UI) — в поведении на 401: по MCP-спеке
(RFC 9728) сервер ОБЯЗАН вернуть ``WWW-Authenticate: Bearer resource_metadata="…"``, чтобы
клиент нашёл AS и начал OAuth. Проверка токена — тем же ``AgentContext.from_request``
(multi-issuer JWT → JWKS, иначе → introspection API-ключа), и так же открывается ALS-scope
(``set_scope``), чтобы MCP-tool handler мог прочитать ``current_ctx()`` — кто вызвал.

Pure-ASGI (НЕ ``BaseHTTPMiddleware``): downstream в ТОЙ ЖЕ задаче → ``contextvars`` доезжают
до MCP-handler'а. Синхронный SDK → ``AgentContext.from_request`` гоняем через ``anyio.to_thread``.
"""

from __future__ import annotations

import json
from typing import Any

import anyio
from ai37_agent_sdk import AgentContext, AgentContextSettings, AuthError, extract_bearer

from ..als import HostScope, reset_scope, set_scope


class McpChallengeGuardMiddleware:
    """ASGI-middleware ``/mcp``: verified ``AgentContext`` → ALS-scope; 401+challenge при required.

    Отвечает challenge'ем (RFC 9728/9110) ТОЛЬКО на путях под ``guarded_prefixes``; остальные
    запросы (в т.ч. публичный protected-resource-metadata) проходят насквозь.
    """

    def __init__(
        self,
        app: Any,
        *,
        settings: AgentContextSettings,
        required: bool,
        resource_metadata_url: str,
        guarded_prefixes: list[str],
        overrides: dict[str, Any] | None = None,
    ) -> None:
        self.app = app
        self._settings = settings
        self._required = required
        self._resource_metadata_url = resource_metadata_url
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
                # Challenge по RFC 9728/9110: клиент извлечёт resource_metadata и пойдёт за токеном.
                await self._send_challenge(send, str(exc))
                return
            # required=false (миграция) — пропускаем без ctx.

        token = set_scope(HostScope(ctx=ctx, bearer=bearer))
        try:
            await self.app(scope, receive, send)
        finally:
            reset_scope(token)

    def _build_ctx(self, headers: dict[str, str]) -> AgentContext:
        return AgentContext.from_request(headers, self._settings, **self._overrides)

    def _is_guarded(self, path: str) -> bool:
        return any(path.startswith(prefix) for prefix in self._prefixes)

    async def _send_challenge(self, send: Any, _detail: str) -> None:
        www_authenticate = (
            f'Bearer resource_metadata="{self._resource_metadata_url}", error="invalid_token"'
        )
        # Тело в форме JSON-RPC-ошибки (MCP поверх StreamableHTTP), id неизвестен → null.
        body = json.dumps(
            {
                "jsonrpc": "2.0",
                "error": {"code": -32001, "message": "unauthorized"},
                "id": None,
            }
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"www-authenticate", www_authenticate.encode("latin-1")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


def _headers_dict(scope: dict[str, Any]) -> dict[str, str]:
    return {
        key.decode("latin-1").lower(): value.decode("latin-1")
        for key, value in scope.get("headers", [])
    }
