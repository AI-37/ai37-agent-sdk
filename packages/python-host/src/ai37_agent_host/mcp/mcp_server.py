"""MCP-сервер поверх официального python ``mcp`` SDK — порт ``ts-host/src/mcp/mcp-server.ts``.

Собирает low-level ``mcp.server.lowlevel.Server`` из набора tool-определений и отдаёт его как
ASGI-приложение (StreamableHTTP, stateless). ``mcp`` SDK — soft-import (optional-группа ``mcp``):
потребители host'а, не использующие MCP-экспорт, его не тянут. Отсутствие пакета → понятная
ошибка при попытке смонтировать MCP (см. :class:`MissingMcpDependencyError`).

Расхождение с TS (``@modelcontextprotocol/sdk``), для ревью:
  * TS создаёт НОВЫЙ ``McpServer``+``StreamableHTTPServerTransport`` НА КАЖДЫЙ HTTP-запрос
    (полностью stateless, session-less). Python-SDK устроен иначе: ``Server`` долгоживущий, а
    ``StreamableHTTPSessionManager`` держит сессии; per-request build не ложится на его модель.
  * ЭКВИВАЛЕНТ per-user набора здесь достигается тем, что ``list_tools``/``call_tool``
    low-level ``Server`` вызываются НА КАЖДЫЙ запрос — резолвер tools (в т.ч. per-user из ALS)
    исполняется внутри них. Так же, как в TS, ``ctx`` берётся из ALS (challenge-guard положил).
  * ``release`` резолвера вызывается в ``finally`` вокруг обработки одного tool-вызова
    (в TS — на ``res.on('close')``); семантика «занял ресурсы на запрос → освободи» сохранена.
"""

from __future__ import annotations

from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Any

from ..als import current_ctx
from .types import McpOptions, McpToolDef, McpToolResult, McpToolSet

_DEFAULT_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "Запрос на естественном языке"},
    },
    "required": ["query"],
}


class MissingMcpDependencyError(RuntimeError):
    """MCP-экспорт запрошен, но пакет ``mcp`` не установлен (optional-группа ``mcp``)."""

    def __init__(self) -> None:
        super().__init__(
            "MCP-экспорт требует пакет 'mcp' (официальный Model Context Protocol Python SDK). "
            "Установите optional-группу: poetry install --with mcp (или pip install mcp)."
        )


def _import_mcp() -> Any:
    """Soft-import ``mcp`` SDK. Бросает :class:`MissingMcpDependencyError`, если пакета нет."""
    try:
        import mcp.types as mcp_types  # noqa: F401
        from mcp.server.lowlevel import Server  # noqa: F401
    except ImportError as exc:  # pragma: no cover - зависит от установки optional-группы
        raise MissingMcpDependencyError() from exc
    return mcp_types, Server


@dataclass
class ServerInfo:
    """Идентификация MCP-сервера в ``initialize`` (имя + версия)."""

    name: str
    version: str


async def _resolve_tools(
    opts: McpOptions,
    ctx: Any,
) -> tuple[list[McpToolDef], Any]:
    """Резолвит tools (статический список или per-request функцию) → ``(tools, release)``.

    Функция-резолвер может вернуть список ИЛИ :class:`McpToolSet` (занял ресурсы на запрос),
    sync или async. Зеркало ветвления ``mcpHttpHandler`` в TS.
    """
    resolver = opts.tools
    if callable(resolver):
        resolved = resolver(ctx)
        if isinstance(resolved, Awaitable):
            resolved = await resolved
    else:
        resolved = resolver

    if isinstance(resolved, McpToolSet):
        return list(resolved.tools), resolved.release
    return list(resolved), None


async def _run_tool(tool: McpToolDef, args: dict[str, Any], ctx: Any) -> McpToolResult:
    """Вызвать handler tool'а (sync или async) с verified ``ctx``."""
    result = tool.handler(args, ctx)
    if isinstance(result, Awaitable):
        result = await result
    return result


async def _call_release(release: Any) -> None:
    """Освободить ресурсы резолвера (sync или async), проглатывая ошибки."""
    if release is None:
        return
    try:
        outcome = release()
        if isinstance(outcome, Awaitable):
            await outcome
    except Exception:  # noqa: BLE001 - освобождение не должно ронять ответ
        pass


def build_mcp_server(server_info: ServerInfo, opts: McpOptions) -> Any:
    """Собрать low-level ``mcp`` ``Server`` с per-request резолвом tools.

    ``list_tools``/``call_tool`` резолвят набор на каждый запрос (читая ``ctx`` из ALS) — так
    достигается per-user набор. Возвращает объект ``mcp.server.lowlevel.Server`` (типизирован
    ``Any``, чтобы host не тянул ``mcp`` в обязательные deps).
    """
    mcp_types, Server = _import_mcp()
    server = Server(server_info.name, version=server_info.version)

    @server.list_tools()
    async def _list_tools() -> list[Any]:  # pyright: ignore[reportUnusedFunction]
        ctx = current_ctx()
        tools, release = await _resolve_tools(opts, ctx)
        try:
            return [
                mcp_types.Tool(
                    name=t.name,
                    description=t.description,
                    inputSchema=t.input_schema or _DEFAULT_INPUT_SCHEMA,
                )
                for t in tools
            ]
        finally:
            await _call_release(release)

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict[str, Any]) -> list[Any]:  # pyright: ignore[reportUnusedFunction]
        ctx = current_ctx()
        tools, release = await _resolve_tools(opts, ctx)
        try:
            tool = next((t for t in tools if t.name == name), None)
            if tool is None:
                raise ValueError(f"Unknown tool: {name}")
            result = await _run_tool(tool, arguments or {}, ctx)
            content = [
                mcp_types.TextContent(type="text", text=block.get("text", ""))
                for block in result.content
            ]
            # low-level call_tool: (content, structuredContent) — второй элемент нам не нужен.
            return content
        finally:
            await _call_release(release)

    return server


def create_mcp_asgi_app(server_info: ServerInfo, opts: McpOptions) -> tuple[Any, Any]:
    """ASGI-приложение MCP-эндпоинта (StreamableHTTP, stateless) + его session-manager.

    Возвращает ``(asgi_app, session_manager)``. ``asgi_app`` монтируется на ``/mcp`` хоста;
    ``session_manager`` ОБЯЗАН быть запущен в lifespan top-level приложения
    (``async with session_manager.run(): ...``) — см. модуль-docstring и ``mount.py``.
    """
    try:
        from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
    except ImportError as exc:  # pragma: no cover - зависит от установки optional-группы
        raise MissingMcpDependencyError() from exc

    server = build_mcp_server(server_info, opts)
    # stateless=True: без Mcp-Session-Id, каждый запрос независим (зеркало TS sessionId=undefined).
    session_manager = StreamableHTTPSessionManager(app=server, stateless=True, json_response=True)

    async def asgi_app(scope: dict[str, Any], receive: Any, send: Any) -> None:
        await session_manager.handle_request(scope, receive, send)

    return asgi_app, session_manager
