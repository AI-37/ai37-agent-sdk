"""JWT-guard как чистый ASGI-middleware — порт ``ts-host/src/auth-guard.ts``.

Пишем pure-ASGI (НЕ ``BaseHTTPMiddleware``): downstream вызывается в ТОЙ ЖЕ задаче, поэтому
ALS-scope (``contextvars``) доезжает до executor'а ``a2a-sdk``. Базовый SDK синхронный →
``AgentContext.from_request`` гоняем через ``anyio.to_thread``, чтобы не блокировать event-loop.

``acceptedOutputModes``/``supportedCatalogIds`` в отличие от TS здесь НЕ парсим из тела:
executor берёт их нативно из ``RequestContext.configuration`` / ``message.metadata``.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import anyio
from ai37_agent_sdk import AgentContext, AgentContextSettings, AuthError, extract_bearer

from .als import HostScope, reset_scope, set_scope
from .metrics import record_auth_failure, record_auth_guard_error

logger = logging.getLogger(__name__)

_MAX_LOGGED_MESSAGE = 200
_BEARER_RE = re.compile(r"Bearer\s+\S+", re.IGNORECASE)
_JWT_RE = re.compile(r"eyJ[\w-]*\.[\w-]*\.[\w-]*")


def _loggable_message(exc: BaseException, bearer: str | None) -> str:
    """Сообщение ошибки для лога: без токена запроса и токеноподобных строк, с обрезкой длины.

    Сообщение произвольной ошибки из auth/billing-пути может нести секрет (токен в тексте
    исключения), поэтому вырезаем токен запроса, ``Bearer …`` и JWT ``eyJ….….…``.
    """
    message = str(exc)
    if bearer:
        message = message.replace(bearer, "[redacted]")
    message = _BEARER_RE.sub("Bearer [redacted]", message)
    message = _JWT_RE.sub("[redacted-jwt]", message)
    if len(message) > _MAX_LOGGED_MESSAGE:
        message = message[:_MAX_LOGGED_MESSAGE] + "…"
    return message


def report_guard_error(service: str, guard: str, exc: BaseException, bearer: str | None) -> None:
    """Сбой проверки при ``required=True``, не являющийся ``AuthError`` → метрика + лог.

    Конфиг (``BillingConfigurationError`` при пустом ``apps_auth_token``), зависимость
    (introspection/JWKS вне обёртки ``AuthError``) или баг. Запрос завершается 503 без деталей
    (fail-closed), детали — в лог без секретов и в ``ai37_agent_auth_guard_errors_total``.
    Общий для :class:`AuthGuardMiddleware` и ``McpChallengeGuardMiddleware``; паритет с
    ``reportGuardError`` в ts-host.
    """
    record_auth_guard_error(service)
    logger.error(
        "[ai37-agent-host] %s-guard: проверка запроса упала не на auth (%s: %s) — "
        "запрос отклонён 503, проверьте конфигурацию auth/billing агента.",
        guard,
        type(exc).__name__,
        _loggable_message(exc, bearer),
    )


class AuthGuardMiddleware:
    """ASGI-middleware: verified AgentContext из заголовков → ALS-scope.

    При ``required``: ``AuthError`` → 401, любой другой сбой проверки (конфиг, недоступная
    зависимость) → 503; downstream не вызывается (fail-closed). При ``required=False`` —
    пропускает без ctx (миграция), в т.ч. при сбое не на ``AuthError``.
    """

    def __init__(
        self,
        app: Any,
        *,
        settings: AgentContextSettings,
        required: bool,
        guarded_prefixes: list[str],
        overrides: dict[str, Any] | None = None,
        service: str = "unknown",
        checkpointer: Any = None,
    ) -> None:
        self.app = app
        self._settings = settings
        self._required = required
        self._prefixes = tuple(guarded_prefixes)
        self._overrides = overrides or {}
        self._service = service
        # Host-предоставленный LangGraph-checkpointer → в turn-scope (см. current_checkpointer).
        self._checkpointer = checkpointer

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
                record_auth_failure(self._service)
                await _send_unauthorized(send, str(exc))
                return
            # required=false → пропускаем без ctx (миграция).
        except Exception as exc:
            if self._required:
                report_guard_error(self._service, "jwt", exc, bearer)
                await _send_json(send, 503, {"error": "auth_unavailable"})
                return
            # required=false → пропускаем без ctx (миграция), как и при AuthError.

        token = set_scope(HostScope(ctx=ctx, bearer=bearer, checkpointer=self._checkpointer))
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
    await _send_json(send, 401, {"error": "unauthorized", "detail": detail})


async def _send_json(send: Any, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json")],
        }
    )
    await send({"type": "http.response.body", "body": body})
