"""Тесты моста ``bridge_handler_to_mcp_tool`` — чистый маппинг когниции в MCP-tool."""

from __future__ import annotations

from typing import Any

from ai37_agent_host.mcp import BridgeToolOptions, bridge_handler_to_mcp_tool
from ai37_agent_host.types import AgentRequest, AgentResult


class _EchoHandler:
    """Возвращает completed с текстом = входным ``text`` (для проверки проброса query)."""

    def __init__(self, result: AgentResult) -> None:
        self._result = result
        self.last_request: AgentRequest | None = None

    async def run(self, req: AgentRequest) -> AgentResult:
        self.last_request = req
        if self._result.message is None and self._result.result is None:
            return AgentResult(status=self._result.status, message=req.input.text)
        return self._result


async def test_bridge_maps_query_and_returns_text():
    handler = _EchoHandler(AgentResult(status="completed"))
    tool = bridge_handler_to_mcp_tool(
        handler, BridgeToolOptions(name="calc", description="считает")
    )
    assert tool.name == "calc"
    assert tool.description == "считает"
    assert tool.input_schema is None  # дефолт {query} проставит mcp-server

    result = await tool.handler({"query": "посчитай лифт"}, None)
    assert result.is_error is False
    assert result.content == [{"type": "text", "text": "посчитай лифт"}]
    # query доехал до handler как input.text; task/context id заполнены
    req = handler.last_request
    assert req is not None
    assert req.input.text == "посчитай лифт"
    assert req.input.task_id and req.input.context_id


async def test_bridge_non_string_query_serialized_to_json():
    handler = _EchoHandler(AgentResult(status="completed"))
    tool = bridge_handler_to_mcp_tool(handler, BridgeToolOptions(name="t", description="d"))
    await tool.handler({"foo": 1, "bar": "x"}, None)
    assert handler.last_request is not None
    text = handler.last_request.input.text
    assert text is not None and '"foo": 1' in text and '"bar": "x"' in text


async def test_bridge_default_render_prefers_message_then_result_then_status():
    # message
    tool = bridge_handler_to_mcp_tool(
        _EchoHandler(AgentResult(status="completed", message="привет")),
        BridgeToolOptions(name="t", description="d"),
    )
    assert (await tool.handler({"query": "x"}, None)).content[0]["text"] == "привет"

    # structured result (dict → JSON)
    tool = bridge_handler_to_mcp_tool(
        _EchoHandler(AgentResult(status="completed", result={"n": 3})),
        BridgeToolOptions(name="t", description="d"),
    )
    out = (await tool.handler({"query": "x"}, None)).content[0]["text"]
    assert '"n": 3' in out

    # failed без message/result → статусный текст + is_error
    tool = bridge_handler_to_mcp_tool(
        _EchoHandler(AgentResult(status="failed", message="сломалось")),
        BridgeToolOptions(name="t", description="d"),
    )
    res = await tool.handler({"query": "x"}, None)
    assert res.is_error is True
    assert res.content[0]["text"] == "сломалось"


async def test_bridge_custom_render_result():
    tool = bridge_handler_to_mcp_tool(
        _EchoHandler(AgentResult(status="completed", result={"kw": 12})),
        BridgeToolOptions(
            name="t",
            description="d",
            render_result=lambda r: f"kw={r.result['kw']}",
        ),
    )
    assert (await tool.handler({"query": "x"}, None)).content[0]["text"] == "kw=12"


async def test_bridge_passes_ctx_claims_and_billing_org():
    handler = _EchoHandler(AgentResult(status="completed", message="ok"))
    tool = bridge_handler_to_mcp_tool(handler, BridgeToolOptions(name="t", description="d"))

    class _Ctx:
        claims: dict[str, Any] = {"sub": "u1"}
        billing_org_id = "org-7"

    await tool.handler({"query": "x"}, _Ctx())
    req = handler.last_request
    assert req is not None
    assert req.ctx is not None
    assert req.input.claims == {"sub": "u1"}
    assert req.input.billing_org_id == "org-7"


async def test_bridge_input_schema_forwarded():
    schema = {"type": "object", "properties": {"a": {"type": "number"}}, "required": ["a"]}
    tool = bridge_handler_to_mcp_tool(
        _EchoHandler(AgentResult(status="completed", message="ok")),
        BridgeToolOptions(name="t", description="d", input_schema=schema),
    )
    assert tool.input_schema == schema
