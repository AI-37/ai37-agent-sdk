"""Монтирование MCP Resource Server поверх host-приложения — порт ``ts-host/src/mcp/mount.ts``.

(1) публичный protected-resource-metadata (discovery), (2) ``/mcp`` за
:class:`McpChallengeGuardMiddleware` (401+challenge + проверка токена + ALS-scope),
(3) StreamableHTTP ASGI-приложение с резолвом tools. Публичный MCP-URL — из ``card_url``
(тот же origin, что A2A-эндпоинт).

Отличия от TS (для ревью — интеграцию сведёт владелец ``create_agent_host``):
  * TS брал origin из ``card.url``. В a2a-sdk 1.x у protobuf-``AgentCard`` нет top-level
    ``url`` (он в ``supported_interfaces[].url``), поэтому :func:`mount_mcp` принимает
    публичный абсолютный URL A2A-эндпоинта СТРОКОЙ (``card_url``) — извлечение из карты
    остаётся на стороне ``create_agent_host``. См. :func:`extract_card_url`.
  * Монтируем на Starlette/FastAPI (``app.router.routes`` + ``app.mount`` + ``add_middleware``),
    а не на express. ``mcp``-сервер требует запуска ``session_manager`` в lifespan top-level
    приложения — :func:`mount_mcp` возвращает его, чтобы владелец вклеил в lifespan.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from ai37_agent_sdk import AgentContextSettings
from starlette.routing import Mount

from .challenge_guard import McpChallengeGuardMiddleware
from .mcp_server import ServerInfo, create_mcp_asgi_app
from .resource_metadata import (
    ProtectedResourceMetadataOptions,
    protected_resource_metadata_routes,
    protected_resource_metadata_url,
)
from .types import McpOptions

#: Путь MCP-эндпоинта (StreamableHTTP) на хосте.
MCP_PATH = "/mcp"


def derive_authorization_servers(auth: Any) -> list[str]:
    """Authentik issuer(ы) из настроек auth → ``authorization_servers`` метаданных.

    Базовый python-SDK (в отличие от TS) хранит один issuer (``auth.issuer``) — multi-issuer
    ``auth.issuers[]`` нет. Preferred-ветка ``issuers`` сохранена как best-effort (если поле
    появится), иначе single-issuer ``auth.issuer``.
    """
    issuers = getattr(auth, "issuers", None)
    if issuers:
        return [getattr(i, "issuer", i) for i in issuers]
    issuer = getattr(auth, "issuer", None)
    return [issuer] if issuer else []


def extract_card_url(card: Any) -> str | None:
    """Публичный абсолютный URL A2A-эндпоинта из карты (dict или protobuf ``AgentCard``).

    Порядок: top-level ``url`` (a2a 0.x / dict-карта) → первый ``supported_interfaces[].url``
    (a2a 1.x protobuf). ``None``, если не найден.
    """
    if isinstance(card, dict):
        url = card.get("url")
        if isinstance(url, str) and url:
            return url
        interfaces = card.get("supportedInterfaces") or card.get("supported_interfaces")
    else:
        url = getattr(card, "url", None)
        if isinstance(url, str) and url:
            return url
        interfaces = getattr(card, "supported_interfaces", None)
    for iface in interfaces or []:
        iface_url = iface.get("url") if isinstance(iface, dict) else getattr(iface, "url", None)
        if isinstance(iface_url, str) and iface_url:
            return iface_url
    return None


def _http_origin(url: str) -> str | None:
    """``origin`` (scheme://host[:port]) если ``url`` — абсолютный http(s)-URL, иначе ``None``."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.netloc:
        return None
    return urlunsplit((parts.scheme, parts.netloc, "", "", ""))


@dataclass
class MountMcpOptions:
    """Опции :func:`mount_mcp`."""

    #: Публичный абсолютный URL A2A-эндпоинта (origin общий с MCP). См. :func:`extract_card_url`.
    card_url: str
    #: Имя ресурса/сервера (обычно ``card.name``) — для consent-экранов и ``initialize``.
    card_name: str
    mcp: McpOptions
    agent_context: AgentContextSettings
    required: bool
    version: str = "0.0.0"
    overrides: dict[str, Any] = field(default_factory=dict)


def mount_mcp(app: Any, opts: MountMcpOptions) -> Any:
    """Смонтировать MCP Resource Server на Starlette/FastAPI-``app``.

    Возвращает ``session_manager`` (его надо запустить в lifespan top-level приложения:
    ``async with session_manager.run(): ...``) или ``None``, если MCP не смонтирован
    (``card_url`` не абсолютный http(s) — тогда host не роняется, A2A/AG-UI работают).
    """
    origin = _http_origin(opts.card_url)
    if origin is None:
        # MCP-экспорту нужен публичный АБСОЛЮТНЫЙ http(s)-URL. Нет/относителен → не монтируем.
        import warnings

        warnings.warn(
            "[ai37-agent-host] mcp: card_url не является абсолютным http(s)-URL — "
            "MCP-эндпоинт не смонтирован (задайте публичный BASE_URL/A2A_HOST_BASE_URL).",
            stacklevel=2,
        )
        return None

    mcp_url = f"{origin}{MCP_PATH}"
    resource_metadata_url = protected_resource_metadata_url(mcp_url)
    authorization_servers = derive_authorization_servers(opts.agent_context.auth)

    # (1) публичный protected-resource-metadata (ДО guard'а).
    routes = protected_resource_metadata_routes(
        ProtectedResourceMetadataOptions(
            resource=mcp_url,
            authorization_servers=authorization_servers,
            scopes_supported=list(opts.mcp.scopes),
            resource_name=opts.card_name,
        )
    )
    app.router.routes.extend(routes)

    # (3) StreamableHTTP ASGI-приложение MCP + session-manager.
    server_info = ServerInfo(name=opts.mcp.server_name or opts.card_name, version=opts.version)
    mcp_app, session_manager = create_mcp_asgi_app(server_info, opts.mcp)
    app.router.routes.append(Mount(MCP_PATH, app=mcp_app))

    # (2) challenge-guard поверх /mcp (401+WWW-Authenticate + проверка токена + ALS-scope).
    app.add_middleware(
        McpChallengeGuardMiddleware,
        settings=opts.agent_context,
        required=opts.required,
        resource_metadata_url=resource_metadata_url,
        guarded_prefixes=[MCP_PATH],
        overrides=opts.overrides,
    )
    return session_manager
