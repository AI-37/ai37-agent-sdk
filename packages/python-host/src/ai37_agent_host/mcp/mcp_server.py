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
  * Кэш текста ресурсов живёт в замыкании долгоживущего ``Server`` (в TS — ``WeakMap`` по
    определению, потому что сервер там собирается на запрос); итог тот же — ``read`` раз на процесс.

MCP Apps (``_meta`` ресурса в ``resources/read``) требуют ``mcp`` ≥ 1.27: раньше
``ReadResourceContents`` не нёс ``meta``.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Any

from ..als import current_ctx
from .types import (
    MCP_APP_RESOURCE_URI_META_KEY,
    McpImageContent,
    McpOptions,
    McpResourceDef,
    McpResourceUi,
    McpTextContent,
    McpToolDef,
    McpToolResult,
    McpToolSet,
    McpToolUi,
)

_DEFAULT_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {"type": "string", "description": "Запрос на естественном языке"},
    },
    "required": ["query"],
}


def _tool_annotations(mcp_types: Any, t: McpToolDef) -> Any:
    """``ToolAnnotations`` инструмента: хинты автора + заголовок из ``t.title``.

    Заголовок кладётся хостом, а не автором (в :class:`McpToolAnnotations` поля ``title`` нет) —
    иначе у одной строки было бы два источника правды. ``mcp_types`` приходит из
    :func:`_import_mcp` вызывающей стороны — свой импорт здесь обошёл бы понятную
    :class:`MissingMcpDependencyError`.
    """
    a = t.annotations
    return mcp_types.ToolAnnotations(
        title=t.title,
        readOnlyHint=a.read_only_hint if a else None,
        destructiveHint=a.destructive_hint if a else None,
        idempotentHint=a.idempotent_hint if a else None,
        openWorldHint=a.open_world_hint if a else None,
    )


def _drop_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


def _tool_ui_meta(ui: McpToolUi) -> dict[str, Any]:
    """``_meta`` инструмента с view: ключ ``ui`` и legacy ``ui/resourceUri`` — хосты читают оба."""
    return {
        "ui": _drop_none({"resourceUri": ui.resource_uri, "visibility": ui.visibility}),
        MCP_APP_RESOURCE_URI_META_KEY: ui.resource_uri,
    }


def _resource_ui_meta(ui: McpResourceUi | None) -> dict[str, Any] | None:
    """``_meta`` ресурса на проводе (camelCase) или ``None``, если автор ничего не просил."""
    if ui is None:
        return None
    csp = ui.csp
    csp_wire = (
        _drop_none(
            {
                "connectDomains": csp.connect_domains,
                "resourceDomains": csp.resource_domains,
                "frameDomains": csp.frame_domains,
                "baseUriDomains": csp.base_uri_domains,
            }
        )
        if csp
        else None
    )
    return {"ui": _drop_none({"csp": csp_wire, "prefersBorder": ui.prefers_border})}


def _content_block(mcp_types: Any, block: McpTextContent | McpImageContent) -> Any:
    """Блок ``content`` результата → ``ImageContent`` или ``TextContent`` MCP SDK."""
    if block["type"] == "image":
        return mcp_types.ImageContent(type="image", data=block["data"], mimeType=block["mimeType"])
    return mcp_types.TextContent(type="text", text=block.get("text", ""))


def _call_tool_result(mcp_types: Any, result: McpToolResult) -> Any:
    """``McpToolResult`` → ``CallToolResult``: ``isError``, ``structuredContent``, ``_meta``."""
    return mcp_types.CallToolResult(
        content=[_content_block(mcp_types, block) for block in result.content],
        structuredContent=result.structured_content,
        isError=result.is_error,
        _meta=result.meta,
    )


def _list_tool(mcp_types: Any, t: McpToolDef) -> Any:
    """Одна запись ``tools/list``."""
    return mcp_types.Tool(
        name=t.name,
        # ecosystem/v5/03-tool-contract.md §6, пункт 2: заголовок отдаётся И верхним
        # полем, И в annotations.title. Раскладываем ОДИН авторский title в обе
        # позиции здесь — чтобы у строки был единственный источник правды.
        title=t.title,
        description=t.description,
        annotations=_tool_annotations(mcp_types, t),
        inputSchema=t.input_schema or _DEFAULT_INPUT_SCHEMA,
        _meta=_tool_ui_meta(t.ui) if t.ui else None,
    )


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
            return [_list_tool(mcp_types, t) for t in tools]
        finally:
            await _call_release(release)

    @server.call_tool()
    async def _call_tool(name: str, arguments: dict[str, Any]) -> Any:  # pyright: ignore[reportUnusedFunction]
        ctx = current_ctx()
        tools, release = await _resolve_tools(opts, ctx)
        try:
            tool = next((t for t in tools if t.name == name), None)
            if tool is None:
                raise ValueError(f"Unknown tool: {name}")
            result = await _run_tool(tool, arguments or {}, ctx)
            # Готовый CallToolResult low-level сервер отдаёт как есть — так доезжают isError,
            # structuredContent и _meta (раньше уходил только список текстовых блоков).
            return _call_tool_result(mcp_types, result)
        finally:
            await _call_release(release)

    if opts.resources:
        _register_resources(server, mcp_types, opts.resources)
    return server


def _register_resources(server: Any, mcp_types: Any, resources: list[McpResourceDef]) -> None:
    """``resources/list`` + ``resources/read`` для view MCP App.

    ``_meta.ui`` кладётся и в запись списка, и в содержимое ``resources/read``: хосты берут CSP из
    второго, а первое — запасной путь по спеке. Текст ``read`` запоминается на процесс (сервер
    долгоживущий); упавший ``read`` не запоминается. Без ресурсов обработчики не регистрируются —
    сервер не объявляет capability ``resources``, как раньше.
    """
    from mcp.server.lowlevel.helper_types import ReadResourceContents
    from mcp.shared.exceptions import McpError

    by_uri = {r.uri: r for r in resources}
    texts: dict[str, str] = {}

    async def read_text(r: McpResourceDef) -> str:
        if r.uri not in texts:
            text = r.read()
            texts[r.uri] = await text if isinstance(text, Awaitable) else text
        return texts[r.uri]

    @server.list_resources()
    async def _list_resources() -> list[Any]:  # pyright: ignore[reportUnusedFunction]
        return [
            mcp_types.Resource(
                uri=r.uri,
                name=r.name,
                description=r.description,
                mimeType=r.mime_type,
                _meta=_resource_ui_meta(r.ui),
            )
            for r in resources
        ]

    @server.read_resource()
    async def _read_resource(uri: Any) -> list[Any]:  # pyright: ignore[reportUnusedFunction]
        r = by_uri.get(str(uri))
        if r is None:
            # Зеркало TS SDK: неизвестный ресурс — InvalidParams с URI в тексте.
            raise McpError(
                mcp_types.ErrorData(
                    code=mcp_types.INVALID_PARAMS, message=f"Resource {uri} not found"
                )
            )
        return [
            ReadResourceContents(
                content=await read_text(r), mime_type=r.mime_type, meta=_resource_ui_meta(r.ui)
            )
        ]


_METHOD_NOT_ALLOWED_BODY = json.dumps(
    {"jsonrpc": "2.0", "error": {"code": -32000, "message": "Method not allowed."}, "id": None}
).encode()


async def _reject_non_post(scope: dict[str, Any], send: Any) -> bool:
    """405 на всё, кроме POST; ``True`` — ответ уже отправлен (зеркало ``ts-host`` mcp-server.ts).

    Stateless-серверу нечего слать в сервер-инициированный SSE (GET), а сессии для DELETE нет.
    Без этого SDK на GET открывает standalone-стрим с пингами, который живёт, пока клиент не уйдёт,
    и держит задачу сервера. 405 — штатный ответ по спеке MCP (Streamable HTTP): клиент понимает,
    что стрима нет, и не переподключается.
    """
    if scope.get("method") == "POST":
        return False
    await send(
        {
            "type": "http.response.start",
            "status": 405,
            "headers": [
                (b"allow", b"POST"),
                (b"content-type", b"application/json"),
                (b"content-length", str(len(_METHOD_NOT_ALLOWED_BODY)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": _METHOD_NOT_ALLOWED_BODY})
    return True


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
        if await _reject_non_post(scope, send):
            return
        await session_manager.handle_request(scope, receive, send)

    return asgi_app, session_manager
