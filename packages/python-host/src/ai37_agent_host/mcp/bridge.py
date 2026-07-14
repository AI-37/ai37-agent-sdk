"""Мост когниции A2A-агента в MCP-tool — порт ``ts-host/src/mcp/bridge.ts``.

Оборачивает :class:`AgentHandler` в одноразовый MCP-tool: собирает :class:`AgentInput` из
аргумента ``query``, зовёт ``handler.run`` (с verified ``ctx`` — билинг/claims сохраняются) и
возвращает текст ответа. Зеркало import-стороны, где внешний A2A-агент оборачивается в
LangChain-tool со схемой ``{query}``. Диалоговость схлопывается: один вызов = один прогон
intent→work→critic→respond (без persistence между вызовами — потребитель передаёт всё в ``query``).
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from ..output_modes import negotiate_output
from ..types import (
    AgentHandler,
    AgentInput,
    AgentRequest,
    AgentResult,
    Ai37Metadata,
)
from .types import McpToolDef, McpToolResult


@dataclass
class BridgeToolOptions:
    """Опции обёртки :func:`bridge_handler_to_mcp_tool`."""

    #: Имя MCP-tool (напр. ``calc_lifts``).
    name: str
    #: Описание для внешней LLM — что делает и что передавать в ``query``.
    description: str
    #: JSON Schema входа; по умолчанию ``{query: string}``.
    input_schema: dict[str, object] | None = None
    #: Форматы текста агента (обычно ``card.defaultOutputModes``) — для негоциации текста.
    text_modes: Sequence[str] | None = None
    #: Кастомный рендер ``AgentResult`` → текст (по умолчанию :func:`_default_render`).
    render_result: Callable[[AgentResult], str] | None = field(default=None)


def _default_render(result: AgentResult) -> str:
    """Текст ответа по умолчанию: приоритет ``message``, затем ``result``, затем статус."""
    if result.message:
        return result.message
    if result.result is not None:
        if isinstance(result.result, str):
            return result.result
        return json.dumps(result.result, ensure_ascii=False, indent=2)
    return "Ошибка выполнения" if result.status == "failed" else "Готово"


def bridge_handler_to_mcp_tool(
    handler: AgentHandler,
    opts: BridgeToolOptions,
) -> McpToolDef:
    """Обернуть когницию :class:`AgentHandler` в :class:`McpToolDef`."""

    async def _handle(args: dict[str, object], ctx: object | None) -> McpToolResult:
        raw_query = args.get("query")
        query = raw_query if isinstance(raw_query, str) else json.dumps(args, ensure_ascii=False)
        run_id = str(uuid.uuid4())
        # MCP — текстовый транспорт: A2UI не негоциируем (пустой набор каталогов клиента).
        negotiation = negotiate_output(
            accepted_output_modes=None,
            agent_text_modes=opts.text_modes,
            supported_catalog_ids=[],
            agent_catalog_ids=None,
        )
        agent_input = AgentInput(
            data={},
            metadata=Ai37Metadata(),
            task_id=run_id,
            context_id=run_id,
            negotiation=negotiation,
            text=query,
            claims=getattr(ctx, "claims", None) if ctx is not None else None,
            billing_org_id=getattr(ctx, "billing_org_id", None) if ctx is not None else None,
        )
        result = await handler.run(
            AgentRequest(input=agent_input, emit=lambda _event: None, ctx=ctx)
        )
        text = opts.render_result(result) if opts.render_result else _default_render(result)
        return McpToolResult(
            content=[{"type": "text", "text": text}],
            is_error=result.status == "failed",
        )

    return McpToolDef(
        name=opts.name,
        description=opts.description,
        handler=_handle,
        input_schema=opts.input_schema,
    )
