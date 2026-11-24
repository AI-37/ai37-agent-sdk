"""MCP Apps на MCP-поверхности хоста; паритет с ``ts-host/test/mcp-apps.test.ts``.

Спека MCP Apps 2026-01-26. View-ресурс, ``_meta.ui`` инструмента и результат с
``_meta``/``structuredContent`` проверяем настоящим клиентом python ``mcp`` SDK поверх in-memory
транспорта.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

import pytest
from mcp import ClientSession
from mcp.shared.exceptions import McpError
from mcp.shared.memory import create_connected_server_and_client_session

from ai37_agent_host.mcp import (
    MCP_APP_MIME_TYPE,
    MCP_APP_RESOURCE_URI_META_KEY,
    McpOptions,
    McpResourceCsp,
    McpResourceDef,
    McpResourceUi,
    McpToolAnnotations,
    McpToolDef,
    McpToolResult,
    McpToolUi,
    ServerInfo,
    build_mcp_server,
)

VIEW_URI = "ui://elevator/a2ui-surface.html"
VIEW_HTML = "<!doctype html><html><body>view</body></html>"
VIEW_UI_META = {"ui": {"csp": {"resourceDomains": []}, "prefersBorder": False}}

A2UI_META: dict[str, Any] = {
    "ai37/a2ui": {
        "version": 1,
        "surfaceId": "lift",
        "messages": [{"version": "v0.9", "createSurface": {"surfaceId": "lift"}}],
        "state": {"gost": "52941", "building": {"N": 17}},
        "actionTool": "lift_form_action",
    }
}

OPEN_FORM_TOOL = McpToolDef(
    name="open_lift_calc_form",
    title="Форма расчёта лифтов",
    description="Открывает форму расчёта",
    annotations=McpToolAnnotations(read_only_hint=True),
    ui=McpToolUi(resource_uri=VIEW_URI),
    handler=lambda _args, _ctx: McpToolResult(
        content=[{"type": "text", "text": "Форма открыта. Предзаполнено: N=17"}],
        meta=A2UI_META,
    ),
)

ACTION_TOOL = McpToolDef(
    name="lift_form_action",
    title="Действие формы лифтов",
    description="Служебный: действие формы, вызывает только view",
    input_schema={
        "type": "object",
        "properties": {"name": {"type": "string"}, "context": {"type": "object"}},
        "required": ["name", "context"],
    },
    ui=McpToolUi(resource_uri=VIEW_URI, visibility=["app"]),
    handler=lambda args, _ctx: McpToolResult(
        content=[{"type": "text", "text": f"действие {args['name']}"}],
        structured_content={"kind": "report", "ok": True},
        meta=A2UI_META,
    ),
)

PLAIN_TOOL = McpToolDef(
    name="calc_lifts",
    title="Расчёт лифтов по ГОСТ",
    description="Расчёт лифтов",
    handler=lambda args, _ctx: McpToolResult(
        content=[{"type": "text", "text": f"got:{args['query']}"}]
    ),
)


def _view(read: Callable[[], Any] = lambda: VIEW_HTML) -> McpResourceDef:
    return McpResourceDef(
        uri=VIEW_URI,
        name="Форма и отчёт расчёта лифтов",
        description="A2UI-поверхность внутри MCP App",
        read=read,
        ui=McpResourceUi(csp=McpResourceCsp(resource_domains=[]), prefers_border=False),
    )


@asynccontextmanager
async def _client(opts: McpOptions) -> AsyncIterator[ClientSession]:
    server = build_mcp_server(ServerInfo(name="test", version="9.9.9"), opts)
    async with create_connected_server_and_client_session(server) as session:
        yield session


def _wire(model: Any) -> dict[str, Any]:
    """Объект клиента → JSON, как он шёл по проводу (alias ``_meta``, без пустых полей)."""
    dumped: dict[str, Any] = model.model_dump(by_alias=True, exclude_none=True, mode="json")
    return dumped


# ─────────────────────────────── tools/list ───────────────────────────────


async def test_tools_list_несёт_meta_ui_и_legacy_ключ() -> None:
    async with _client(McpOptions(tools=[OPEN_FORM_TOOL], resources=[_view()])) as client:
        tools = (await client.list_tools()).tools

    tool = _wire(tools[0])
    assert tool["_meta"] == {
        "ui": {"resourceUri": VIEW_URI},
        MCP_APP_RESOURCE_URI_META_KEY: VIEW_URI,
    }
    assert MCP_APP_RESOURCE_URI_META_KEY == "ui/resourceUri"
    # Заголовок и хинты на месте: ui их не вытесняет.
    assert tool["title"] == "Форма расчёта лифтов"
    assert tool["annotations"] == {"title": "Форма расчёта лифтов", "readOnlyHint": True}


async def test_app_only_инструмент_виден_в_tools_list_с_visibility_app() -> None:
    opts = McpOptions(tools=[OPEN_FORM_TOOL, ACTION_TOOL], resources=[_view()])
    async with _client(opts) as client:
        tools = (await client.list_tools()).tools

    assert [t.name for t in tools] == ["open_lift_calc_form", "lift_form_action"]
    action = _wire(tools[1])
    # Прячет его хост, а не сервер: в списке он есть.
    assert action["_meta"] == {
        "ui": {"resourceUri": VIEW_URI, "visibility": ["app"]},
        "ui/resourceUri": VIEW_URI,
    }
    assert action["title"] == "Действие формы лифтов"


async def test_инструмент_без_ui_без_meta_как_раньше() -> None:
    async with _client(McpOptions(tools=[PLAIN_TOOL])) as client:
        tools = (await client.list_tools()).tools

    assert len(tools) == 1
    assert "_meta" not in _wire(tools[0])


# ─────────────────────────────── resources ───────────────────────────────


async def test_resources_list_отдаёт_mime_профиля_и_meta_ui() -> None:
    async with _client(McpOptions(tools=[OPEN_FORM_TOOL], resources=[_view()])) as client:
        resources = (await client.list_resources()).resources

    assert [_wire(r) for r in resources] == [
        {
            "uri": VIEW_URI,
            "name": "Форма и отчёт расчёта лифтов",
            "description": "A2UI-поверхность внутри MCP App",
            "mimeType": "text/html;profile=mcp-app",
            "_meta": VIEW_UI_META,
        }
    ]
    assert MCP_APP_MIME_TYPE == "text/html;profile=mcp-app"


async def test_resources_read_отдаёт_html_mime_и_meta_ui() -> None:
    async with _client(McpOptions(tools=[OPEN_FORM_TOOL], resources=[_view()])) as client:
        res = await client.read_resource(VIEW_URI)  # type: ignore[arg-type]

    assert [_wire(c) for c in res.contents] == [
        {
            "uri": VIEW_URI,
            "mimeType": "text/html;profile=mcp-app",
            "text": VIEW_HTML,
            "_meta": VIEW_UI_META,
        }
    ]


async def test_свой_mime_и_ресурс_без_ui_и_async_read() -> None:
    async def read() -> str:
        return "привет"

    plain = McpResourceDef(
        uri="ui://test/plain.txt", name="plain", mime_type="text/plain", read=read
    )
    async with _client(McpOptions(tools=[], resources=[plain])) as client:
        listed = _wire((await client.list_resources()).resources[0])
        res = await client.read_resource("ui://test/plain.txt")  # type: ignore[arg-type]

    assert listed["mimeType"] == "text/plain"
    assert "_meta" not in listed
    assert [_wire(c) for c in res.contents] == [
        {"uri": "ui://test/plain.txt", "mimeType": "text/plain", "text": "привет"}
    ]


async def test_read_зовётся_один_раз_на_процесс() -> None:
    reads: list[int] = []

    def read() -> str:
        reads.append(1)
        return VIEW_HTML

    async with _client(McpOptions(tools=[OPEN_FORM_TOOL], resources=[_view(read)])) as client:
        for _ in range(2):
            res = await client.read_resource(VIEW_URI)  # type: ignore[arg-type]
            assert _wire(res.contents[0])["text"] == VIEW_HTML

    assert len(reads) == 1


async def test_упавший_read_не_запоминается() -> None:
    reads: list[int] = []

    def read() -> str:
        reads.append(1)
        if len(reads) == 1:
            raise RuntimeError("файл ещё не готов")
        return VIEW_HTML

    async with _client(McpOptions(tools=[OPEN_FORM_TOOL], resources=[_view(read)])) as client:
        with pytest.raises(McpError, match="файл ещё не готов"):
            await client.read_resource(VIEW_URI)  # type: ignore[arg-type]
        res = await client.read_resource(VIEW_URI)  # type: ignore[arg-type]

    assert _wire(res.contents[0])["text"] == VIEW_HTML
    assert len(reads) == 2


async def test_неизвестный_uri_ошибка_протокола() -> None:
    async with _client(McpOptions(tools=[OPEN_FORM_TOOL], resources=[_view()])) as client:
        with pytest.raises(McpError, match="ui://elevator/nope.html"):
            await client.read_resource("ui://elevator/nope.html")  # type: ignore[arg-type]


async def test_без_resources_сервер_не_объявляет_resources() -> None:
    server = build_mcp_server(ServerInfo(name="t", version="1"), McpOptions(tools=[PLAIN_TOOL]))
    async with create_connected_server_and_client_session(server) as client:
        with pytest.raises(McpError):
            await client.list_resources()

    capabilities = server.get_capabilities(_notification_options(), {})
    assert capabilities.resources is None


def _notification_options() -> Any:
    from mcp.server.lowlevel import NotificationOptions

    return NotificationOptions()


# ─────────────────────────────── результат ───────────────────────────────


async def test_meta_и_structured_content_доходят_до_клиента() -> None:
    opts = McpOptions(tools=[OPEN_FORM_TOOL, ACTION_TOOL], resources=[_view()])
    async with _client(opts) as client:
        res = await client.call_tool("lift_form_action", {"name": "calc", "context": {"N": 17}})

    assert _wire(res) == {
        "content": [{"type": "text", "text": "действие calc"}],
        "structuredContent": {"kind": "report", "ok": True},
        "isError": False,
        "_meta": A2UI_META,
    }


async def test_картинка_в_content_проходит_как_image_content() -> None:
    chart = McpToolDef(
        name="chart",
        title="График",
        description="d",
        handler=lambda _a, _c: McpToolResult(
            content=[
                {"type": "text", "text": "график ниже"},
                {"type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png"},
            ]
        ),
    )
    async with _client(McpOptions(tools=[chart])) as client:
        res = await client.call_tool("chart", {"query": "x"})

    assert _wire(res)["content"] == [
        {"type": "text", "text": "график ниже"},
        {"type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png"},
    ]


async def test_инструмент_без_ui_отвечает_как_раньше() -> None:
    async with _client(McpOptions(tools=[PLAIN_TOOL])) as client:
        res = await client.call_tool("calc_lifts", {"query": "дом"})

    assert _wire(res) == {"content": [{"type": "text", "text": "got:дом"}], "isError": False}


async def test_is_error_доходит_до_клиента() -> None:
    """Паритет с TS: раньше python-хост терял флаг и всегда отвечал ``isError: false``."""
    failing = McpToolDef(
        name="fail",
        title="Падающий",
        description="d",
        handler=lambda _a, _c: McpToolResult(
            content=[{"type": "text", "text": "не вышло"}], is_error=True
        ),
    )
    async with _client(McpOptions(tools=[failing])) as client:
        res = await client.call_tool("fail", {"query": "x"})

    assert res.isError is True
    assert _wire(res)["content"] == [{"type": "text", "text": "не вышло"}]
