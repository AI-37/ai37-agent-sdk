"""Инструкции MCP-сервера (``instructions`` в ответе ``initialize``).

Ими направляем модель хоста — например, «на "рассчитай лифты" открывай форму, а не структурный
инструмент». Проверяем настоящим клиентом python ``mcp`` SDK поверх in-memory транспорта; паритет —
``ts-host/test/mcp-instructions.test.ts``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import anyio
from mcp import ClientSession
from mcp.shared.memory import create_client_server_memory_streams

from ai37_agent_host.mcp import McpOptions, McpToolDef, McpToolResult, ServerInfo, build_mcp_server

INSTRUCTIONS = "Когда пользователь просит рассчитать лифты, открой форму open_lift_calc_form."

TOOL = McpToolDef(
    name="open_lift_calc_form",
    title="Форма расчёта лифтов",
    description="Открывает форму расчёта",
    handler=lambda _args, _ctx: McpToolResult(content=[{"type": "text", "text": "ок"}]),
)


@asynccontextmanager
async def _initialized(opts: McpOptions) -> AsyncIterator[tuple[ClientSession, Any]]:
    """Клиент после ``initialize`` и сам ответ ``initialize`` (готовый хелпер SDK его теряет)."""
    server = build_mcp_server(ServerInfo(name="test", version="9.9.9"), opts)
    async with create_client_server_memory_streams() as (client_streams, server_streams):
        async with anyio.create_task_group() as tg:
            tg.start_soon(
                lambda: server.run(*server_streams, server.create_initialization_options())
            )
            try:
                async with ClientSession(*client_streams) as session:
                    yield session, await session.initialize()
            finally:
                tg.cancel_scope.cancel()


def _wire(model: Any) -> dict[str, Any]:
    """Ответ ``initialize`` → JSON, как он шёл по проводу (без пустых полей)."""
    dumped: dict[str, Any] = model.model_dump(by_alias=True, exclude_none=True, mode="json")
    return dumped


async def test_initialize_отдаёт_instructions() -> None:
    async with _initialized(McpOptions(tools=[TOOL], instructions=INSTRUCTIONS)) as (_, init):
        assert init.instructions == INSTRUCTIONS
        assert _wire(init)["instructions"] == INSTRUCTIONS


async def test_без_instructions_поля_нет_и_сервер_работает_как_раньше() -> None:
    async with _initialized(McpOptions(tools=[TOOL])) as (session, init):
        assert "instructions" not in _wire(init)
        tools = (await session.list_tools()).tools
    assert [t.name for t in tools] == ["open_lift_calc_form"]


async def test_пустая_строка_то_же_что_не_задано() -> None:
    async with _initialized(McpOptions(tools=[TOOL], instructions="")) as (_, init):
        assert "instructions" not in _wire(init)
