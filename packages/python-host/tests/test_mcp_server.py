"""Тесты MCP-сервера: graceful-degradation при отсутствии ``mcp`` SDK + резолв tools.

``mcp`` SDK в этой среде НЕ установлен — покрываем soft-import (понятная ошибка) и чистый
резолвер tools/release, не требующий сервера.
"""

from __future__ import annotations

import importlib.util

import pytest

from ai37_agent_host.mcp import (
    McpOptions,
    McpToolAnnotations,
    McpToolDef,
    McpToolResult,
    McpToolSet,
    MissingMcpDependencyError,
    ServerInfo,
    build_mcp_server,
    create_mcp_asgi_app,
)
from ai37_agent_host.mcp import mcp_server as mcp_server_mod

_MCP_INSTALLED = importlib.util.find_spec("mcp") is not None


def _tool(name: str) -> McpToolDef:
    return McpToolDef(
        name=name,
        title=f"Заголовок {name}",
        description="d",
        handler=lambda _args, _ctx: McpToolResult(content=[{"type": "text", "text": name}]),
    )


@pytest.mark.skipif(_MCP_INSTALLED, reason="проверяем поведение БЕЗ установленного mcp SDK")
def test_build_server_raises_clear_error_without_mcp():
    with pytest.raises(MissingMcpDependencyError) as exc:
        build_mcp_server(ServerInfo(name="s", version="1.0.0"), McpOptions(tools=[_tool("a")]))
    assert "mcp" in str(exc.value)


@pytest.mark.skipif(_MCP_INSTALLED, reason="проверяем поведение БЕЗ установленного mcp SDK")
def test_create_asgi_app_raises_clear_error_without_mcp():
    with pytest.raises(MissingMcpDependencyError):
        create_mcp_asgi_app(ServerInfo(name="s", version="1.0.0"), McpOptions(tools=[_tool("a")]))


async def test_resolve_tools_static_list():
    tools, release = await mcp_server_mod._resolve_tools(
        McpOptions(tools=[_tool("a"), _tool("b")]), None
    )
    assert [t.name for t in tools] == ["a", "b"]
    assert release is None


async def test_resolve_tools_callable_returning_list():
    opts = McpOptions(tools=lambda _ctx: [_tool("x")])
    tools, release = await mcp_server_mod._resolve_tools(opts, None)
    assert [t.name for t in tools] == ["x"]
    assert release is None


async def test_resolve_tools_async_callable_returning_toolset_with_release():
    released: list[bool] = []

    async def resolver(_ctx: object) -> McpToolSet:
        return McpToolSet(tools=[_tool("y")], release=lambda: released.append(True))

    tools, release = await mcp_server_mod._resolve_tools(McpOptions(tools=resolver), None)
    assert [t.name for t in tools] == ["y"]
    await mcp_server_mod._call_release(release)
    assert released == [True]


async def test_resolve_tools_receives_ctx():
    seen: dict[str, object] = {}

    def resolver(ctx: object) -> list[McpToolDef]:
        seen["ctx"] = ctx
        return [_tool("z")]

    marker = object()
    await mcp_server_mod._resolve_tools(McpOptions(tools=resolver), marker)
    assert seen["ctx"] is marker


async def test_run_tool_supports_sync_and_async_handlers():
    sync_tool = McpToolDef(
        name="s",
        title="Заголовок s",
        description="d",
        handler=lambda _a, _c: McpToolResult(content=[{"type": "text", "text": "sync"}]),
    )

    async def _ah(_a: object, _c: object) -> McpToolResult:
        return McpToolResult(content=[{"type": "text", "text": "async"}])

    async_tool = McpToolDef(name="a", title="Заголовок a", description="d", handler=_ah)

    r1 = await mcp_server_mod._run_tool(sync_tool, {}, None)
    r2 = await mcp_server_mod._run_tool(async_tool, {}, None)
    assert r1.content[0]["text"] == "sync"
    assert r2.content[0]["text"] == "async"


async def test_call_release_swallows_errors_and_handles_none():
    await mcp_server_mod._call_release(None)  # no-op

    def boom() -> None:
        raise RuntimeError("nope")

    await mcp_server_mod._call_release(boom)  # проглочено, не бросает


class _FakeToolAnnotations:
    """Двойник ``mcp.types.ToolAnnotations``: запоминает kwargs, которыми его собрали."""

    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs


class _FakeMcpTypes:
    """Достаточный кусок ``mcp.types`` для проверки сборки аннотаций без установленного SDK."""

    ToolAnnotations = _FakeToolAnnotations


def test_tool_annotations_кладёт_title_и_пробрасывает_хинты() -> None:
    """``v5/03`` §6 п.2: заголовок обязан уехать и в ``annotations.title``.

    Хост берёт его из ``McpToolDef.title`` (в ``McpToolAnnotations`` поля ``title`` нет намеренно —
    у строки один источник правды), а хинты автора при этом не должны теряться.
    """
    tool = McpToolDef(
        name="calc_lifts",
        title="Расчёт лифтов по ГОСТ",
        description="d",
        annotations=McpToolAnnotations(read_only_hint=True, idempotent_hint=True),
        handler=lambda _args, _ctx: McpToolResult(content=[]),
    )

    ann = mcp_server_mod._tool_annotations(_FakeMcpTypes, tool)

    assert ann.kwargs["title"] == "Расчёт лифтов по ГОСТ"
    assert ann.kwargs["title"] != tool.name  # заголовок не повторяет машинное имя (§3)
    assert ann.kwargs["readOnlyHint"] is True
    assert ann.kwargs["idempotentHint"] is True
    assert ann.kwargs["destructiveHint"] is None
    assert ann.kwargs["openWorldHint"] is None


def test_tool_annotations_без_хинтов_всё_равно_несёт_title() -> None:
    """``annotations`` необязательны, ``title`` — нет: заголовок уезжает и без единого хинта."""
    tool = McpToolDef(
        name="t",
        title="Заголовок инструмента",
        description="d",
        handler=lambda _args, _ctx: McpToolResult(content=[]),
    )

    ann = mcp_server_mod._tool_annotations(_FakeMcpTypes, tool)

    assert ann.kwargs["title"] == "Заголовок инструмента"
    assert ann.kwargs["readOnlyHint"] is None
