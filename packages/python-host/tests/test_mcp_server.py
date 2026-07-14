"""Тесты MCP-сервера: graceful-degradation при отсутствии ``mcp`` SDK + резолв tools.

``mcp`` SDK в этой среде НЕ установлен — покрываем soft-import (понятная ошибка) и чистый
резолвер tools/release, не требующий сервера.
"""

from __future__ import annotations

import importlib.util

import pytest

from ai37_agent_host.mcp import (
    McpOptions,
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
        description="d",
        handler=lambda _a, _c: McpToolResult(content=[{"type": "text", "text": "sync"}]),
    )

    async def _ah(_a: object, _c: object) -> McpToolResult:
        return McpToolResult(content=[{"type": "text", "text": "async"}])

    async_tool = McpToolDef(name="a", description="d", handler=_ah)

    r1 = await mcp_server_mod._run_tool(sync_tool, {}, None)
    r2 = await mcp_server_mod._run_tool(async_tool, {}, None)
    assert r1.content[0]["text"] == "sync"
    assert r2.content[0]["text"] == "async"


async def test_call_release_swallows_errors_and_handles_none():
    await mcp_server_mod._call_release(None)  # no-op

    def boom() -> None:
        raise RuntimeError("nope")

    await mcp_server_mod._call_release(boom)  # проглочено, не бросает
