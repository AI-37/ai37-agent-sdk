"""OAuth protected-resource-metadata (RFC 9728) — порт ``ts-host/src/mcp/resource-metadata.ts``.

Точка входа OAuth-discovery: клиент узнаёт, к какому AS (Authentik) идти за токеном. Роуты
публичны (монтируются ДО guard'а). В TS был express Router; здесь — Starlette ``Route``-список
(host на FastAPI/Starlette), плюс чистые функции сборки URL/тела (тестируемы без ASGI).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

_WELL_KNOWN = "/.well-known/oauth-protected-resource"


@dataclass
class ProtectedResourceMetadataOptions:
    """Опции документа protected-resource-metadata."""

    #: Канонический публичный URL MCP-эндпоинта, напр. ``https://elev.app.sp-ai.ru/mcp``.
    resource: str
    #: Authorization Server(ы), выдающие токены для этого ресурса — issuer-идентификаторы
    #: (Authentik). Клиент сам добавит ``/.well-known/oauth-authorization-server`` (RFC 8414)
    #: или ``/.well-known/openid-configuration`` и продолжит discovery.
    authorization_servers: list[str]
    #: Публикуемые scopes (``scopes_supported``).
    scopes_supported: list[str] = field(default_factory=list)
    #: Человекочитаемое имя ресурса (для consent-экранов клиентов).
    resource_name: str | None = None


def protected_resource_metadata_url(mcp_url: str) -> str:
    """URL документа protected-resource-metadata (RFC 9728) для данного MCP-URL.

    Путь ресурса переносится в СУФФИКС ``.well-known``-пути
    (``https://h/mcp`` → ``https://h/.well-known/oauth-protected-resource/mcp``).
    Этот URL кладётся в заголовок ``WWW-Authenticate: Bearer resource_metadata="…"``.
    """
    parts = urlsplit(mcp_url)
    origin = urlunsplit((parts.scheme, parts.netloc, "", "", ""))
    path = "" if parts.path == "/" else parts.path
    return f"{origin}{_WELL_KNOWN}{path}"


def build_protected_resource_metadata(
    opts: ProtectedResourceMetadataOptions,
) -> dict[str, Any]:
    """Тело документа protected-resource-metadata (RFC 9728) — чистая сборка JSON."""
    body: dict[str, Any] = {
        "resource": opts.resource,
        "authorization_servers": opts.authorization_servers,
    }
    if opts.scopes_supported:
        body["scopes_supported"] = opts.scopes_supported
    if opts.resource_name:
        body["resource_name"] = opts.resource_name
    body["bearer_methods_supported"] = ["header"]
    return body


def protected_resource_metadata_routes(
    opts: ProtectedResourceMetadataOptions,
) -> list[Route]:
    """Starlette ``Route``-список, отдающий документ protected-resource-metadata.

    Отдаём и корневой ``/.well-known/oauth-protected-resource``, и path-суффиксный вариант
    (RFC 9728 §3.1: клиенты пробуют оба). Монтируется ДО guard'а — метаданные публичны.
    """
    body = build_protected_resource_metadata(opts)

    async def handler(_request: Request) -> JSONResponse:
        return JSONResponse(body)

    origin = urlunsplit((*urlsplit(opts.resource)[:2], "", "", ""))
    suffix = protected_resource_metadata_url(opts.resource).replace(origin, "", 1)

    routes = [Route(_WELL_KNOWN, handler, methods=["GET"])]
    if suffix != _WELL_KNOWN:
        routes.append(Route(suffix, handler, methods=["GET"]))
    return routes
