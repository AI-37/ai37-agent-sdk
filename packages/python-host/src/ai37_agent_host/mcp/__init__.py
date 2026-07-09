"""MCP Resource Server слой agent-host — порт ``ts-host/src/mcp/index.ts``.

Превращает агента в MCP-сервер (StreamableHTTP) для внешних клиентов (Claude/Cursor) с
OAuth-discovery (protected-resource-metadata) и той же проверкой токена, что A2A/AG-UI.

``mcp`` SDK — soft-import (optional-группа ``mcp``): импорт этого пакета НЕ требует ``mcp``,
он подгружается лениво при :func:`build_mcp_server`/:func:`mount_mcp`.
"""

from __future__ import annotations

from .bridge import BridgeToolOptions, bridge_handler_to_mcp_tool
from .challenge_guard import McpChallengeGuardMiddleware
from .mcp_server import (
    MissingMcpDependencyError,
    ServerInfo,
    build_mcp_server,
    create_mcp_asgi_app,
)
from .mount import (
    MCP_PATH,
    MountMcpOptions,
    derive_authorization_servers,
    extract_card_url,
    mount_mcp,
)
from .resource_metadata import (
    ProtectedResourceMetadataOptions,
    build_protected_resource_metadata,
    protected_resource_metadata_routes,
    protected_resource_metadata_url,
)
from .types import (
    McpOptions,
    McpToolDef,
    McpToolHandler,
    McpToolResult,
    McpToolSet,
    McpToolsResolver,
)

__all__ = [
    # types
    "McpOptions",
    "McpToolDef",
    "McpToolHandler",
    "McpToolResult",
    "McpToolSet",
    "McpToolsResolver",
    # resource-metadata
    "ProtectedResourceMetadataOptions",
    "build_protected_resource_metadata",
    "protected_resource_metadata_routes",
    "protected_resource_metadata_url",
    # challenge-guard
    "McpChallengeGuardMiddleware",
    # mcp-server
    "MissingMcpDependencyError",
    "ServerInfo",
    "build_mcp_server",
    "create_mcp_asgi_app",
    # bridge
    "BridgeToolOptions",
    "bridge_handler_to_mcp_tool",
    # mount
    "MCP_PATH",
    "MountMcpOptions",
    "derive_authorization_servers",
    "extract_card_url",
    "mount_mcp",
]
