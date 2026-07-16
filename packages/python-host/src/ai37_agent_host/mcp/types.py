"""Контракты MCP Resource Server слоя — порт ``ts-host/src/mcp/types.ts``.

MCP-экспорт превращает агента в MCP-сервер (StreamableHTTP) для внешних клиентов
(Claude/Cursor) с OAuth-discovery (protected-resource-metadata) и той же проверкой
токена, что A2A/AG-UI. Здесь — типы tool-определений и опций.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from ai37_agent_sdk import AgentContext


@dataclass
class McpToolResult:
    """Результат одного MCP tool-вызова — подмножество ``CallToolResult`` MCP SDK.

    Только текстовый контент + флаг ошибки; этого достаточно для наших агентов. Форма
    ``content`` зеркалит MCP: список ``{"type": "text", "text": ...}``.
    """

    content: list[dict[str, str]]
    is_error: bool = False


#: Handler MCP-tool: получает провалидированные аргументы и verified ``AgentContext``
#: (кто вызвал) — им и делается мост на когницию агента или на per-user набор инструментов.
#: Sync или async (в отличие от TS ``Promise | value`` — здесь корутина или готовое значение).
McpToolHandler = Callable[
    [dict[str, Any], AgentContext | None],
    McpToolResult | Awaitable[McpToolResult],
]


@dataclass
class McpToolDef:
    """Определение MCP-tool, экспонируемого хостом наружу.

    ``input_schema`` — JSON Schema объекта аргументов (``{"type": "object", ...}``); по
    умолчанию ``{query: string}`` (зеркало import-стороны, где A2A-агент оборачивается в
    LangChain-tool со схемой ``{query}``). В отличие от TS (zod raw shape) здесь JSON Schema
    — нативная форма python ``mcp`` SDK (``Tool.inputSchema``). ``handler`` получает
    провалидированные аргументы и verified ``AgentContext``.
    """

    name: str
    description: str
    handler: McpToolHandler
    input_schema: dict[str, Any] | None = None


@dataclass
class McpToolSet:
    """Набор tools + опциональное освобождение ресурсов ПОСЛЕ запроса.

    Резолвер, который что-то «занимает» на запрос (ref-count кэша, per-user коннекты),
    возвращает ``release`` — хост вызовет его на закрытии ответа. ``release`` sync или async.
    """

    tools: list[McpToolDef]
    release: Callable[[], Any] | None = None


#: Резолвер набора tools. Либо статический список (elevator/rag — набор известен на старте),
#: либо функция per-request, получающая verified ``AgentContext`` — так chat-backend строит
#: НАБОР ПО ПОЛЬЗОВАТЕЛЮ из токена запроса (агрегатор его интеграций). Функция может вернуть
#: просто список ИЛИ :class:`McpToolSet` (если набор занимает ресурсы на время запроса).
McpToolsResolver = (
    list[McpToolDef]
    | Callable[
        [AgentContext | None],
        list[McpToolDef] | McpToolSet | Awaitable[list[McpToolDef] | McpToolSet],
    ]
)


@dataclass
class McpOptions:
    """Опция ``mcp`` для ``create_agent_host``: превращает агента в MCP Resource Server."""

    #: Статический список tools или per-request резолвер (для per-user наборов).
    tools: McpToolsResolver
    #: OAuth-scopes, публикуемые в protected-resource-metadata (``scopes_supported``).
    scopes: list[str] = field(default_factory=list)
    #: Имя MCP-сервера в initialize (по умолчанию — ``card.name``).
    server_name: str | None = None
