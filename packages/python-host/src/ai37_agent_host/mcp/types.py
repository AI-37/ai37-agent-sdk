"""Контракты MCP Resource Server слоя — порт ``ts-host/src/mcp/types.ts``.

MCP-экспорт превращает агента в MCP-сервер (StreamableHTTP) для внешних клиентов
(Claude/Cursor) с OAuth-discovery (protected-resource-metadata) и той же проверкой
токена, что A2A/AG-UI. Здесь — типы tool-определений и опций.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

from ai37_agent_sdk import AgentContext

#: MIME ресурса MCP App — HTML-view, который хост рисует в песочнице рядом с ответом модели.
#: Спека MCP Apps 2026-01-26 (``io.modelcontextprotocol/ui``), в ``@modelcontextprotocol/ext-apps``
#: это ``RESOURCE_MIME_TYPE``. Зеркало TS ``MCP_APP_MIME_TYPE``.
MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"

#: Legacy-ключ ``_meta`` инструмента со ссылкой на view (та же спека, ``RESOURCE_URI_META_KEY``
#: в ext-apps). Хосты постарше читают только его, новые — ``_meta.ui.resourceUri``; хост отдаёт
#: оба. Зеркало TS ``MCP_APP_RESOURCE_URI_META_KEY``.
MCP_APP_RESOURCE_URI_META_KEY = "ui/resourceUri"


class McpTextContent(TypedDict):
    """Текстовый блок результата (``TextContent`` MCP). Зеркало TS ``McpTextContent``."""

    type: Literal["text"]
    text: str


class McpImageContent(TypedDict):
    """Картинка в результате (``ImageContent`` MCP): base64 без префикса ``data:`` и её MIME.

    Ключ ``mimeType`` — в camelCase, как на проводе. Зеркало TS ``McpImageContent``.
    """

    type: Literal["image"]
    data: str
    mimeType: str


@dataclass
class McpToolResult:
    """Результат одного MCP tool-вызова — подмножество ``CallToolResult`` MCP SDK.

    ``content`` — то, что видит модель, в форме MCP: ``{"type": "text", "text": ...}`` или
    ``{"type": "image", "data": <base64>, "mimeType": ...}``. ``structured_content`` —
    JSON-результат для клиента. Осторожно: хост без UI (Claude Code) отдаёт модели
    ``structuredContent`` ВМЕСТО ``content``, так что большой JSON сюда класть нельзя. ``meta``
    (``_meta``) модели не показывает ни один хост: это канал для view MCP App (так в нём едет
    поток A2UI, ``meta["ai37/a2ui"]``).
    """

    content: list[McpTextContent | McpImageContent]
    is_error: bool = False
    structured_content: dict[str, Any] | None = None
    meta: dict[str, Any] | None = None


#: Handler MCP-tool: получает провалидированные аргументы и verified ``AgentContext``
#: (кто вызвал) — им и делается мост на когницию агента или на per-user набор инструментов.
#: Sync или async (в отличие от TS ``Promise | value`` — здесь корутина или готовое значение).
McpToolHandler = Callable[
    [dict[str, Any], AgentContext | None],
    McpToolResult | Awaitable[McpToolResult],
]


@dataclass
class McpToolAnnotations:
    """Хинты поведения инструмента (``ToolAnnotations`` MCP-спеки) — БЕЗ ``title``.

    Заголовок сюда не кладут: он живёт в :attr:`McpToolDef.title` и раскладывается в обе
    позиции ответа ``tools/list`` самим хостом. Зеркало TS ``McpToolAnnotations``.
    """

    read_only_hint: bool | None = None
    destructive_hint: bool | None = None
    idempotent_hint: bool | None = None
    open_world_hint: bool | None = None


#: Кто видит инструмент: модель (``model``), view MCP App (``app``). По умолчанию — оба.
McpToolVisibility = Literal["model", "app"]


@dataclass
class McpToolUi:
    """UI инструмента по MCP Apps: какой view хост рисует на его результат и кому он виден.

    ``visibility=["app"]`` — служебный инструмент view (кнопки формы): модель его не видит, но в
    ``tools/list`` он есть — прячет его хост, а не сервер. Зеркало TS ``McpToolUi``.
    """

    #: ``ui://…`` ресурса из :attr:`McpOptions.resources`.
    resource_uri: str
    visibility: list[McpToolVisibility] | None = None


@dataclass
class McpResourceCsp:
    """Источники, которые view разрешено трогать из песочницы (CSP хоста).

    Пусто — ничего: view живёт на том, что принёс в себе, и на вызовах инструментов через хост.
    Зеркало TS ``McpResourceCsp``; на проводе — camelCase.
    """

    #: ``connect-src``: fetch/XHR/WebSocket.
    connect_domains: list[str] | None = None
    #: ``img-src``/``script-src``/``style-src``/``font-src``/``media-src``.
    resource_domains: list[str] | None = None
    #: ``frame-src``: вложенные iframe.
    frame_domains: list[str] | None = None
    #: ``base-uri``.
    base_uri_domains: list[str] | None = None


@dataclass
class McpResourceUi:
    """Пожелания view к хосту: CSP песочницы и рамка (``_meta.ui`` ресурса). Зеркало TS."""

    csp: McpResourceCsp | None = None
    #: ``True`` — рамка и фон от хоста, ``False`` — без них, ``None`` — решает хост.
    prefers_border: bool | None = None


@dataclass
class McpResourceDef:
    """Ресурс MCP-сервера; на практике — HTML-view MCP App (``ui://…``).

    ``read`` (sync или async) хост зовёт один раз на процесс и дальше отдаёт запомненный текст:
    view приезжает в образ зависимостью и не меняется. Зеркало TS ``McpResourceDef``.
    """

    #: ``ui://<агент>/<view>.html`` — на него ссылается :attr:`McpToolUi.resource_uri`.
    uri: str
    name: str
    read: Callable[[], str | Awaitable[str]]
    description: str | None = None
    mime_type: str = MCP_APP_MIME_TYPE
    ui: McpResourceUi | None = None
    #: Тот же текст отдаётся и по любому адресу ``<uri_prefix><хвост без '/' и ','>``. Хост
    #: кэширует ``tools/list``: после смены адреса view он спрашивает форму по старому и без этого
    #: получил бы «Resource not found». В ``resources/list`` прежние адреса не попадают.
    uri_prefix: str | None = None


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
    #: Человекочитаемый заголовок. ОБЯЗАТЕЛЕН (``ecosystem/v5/03-tool-contract.md`` §2/§6):
    #: выставленный наружу инструмент — публичный API, и портал подачи Anthropic блокирует
    #: инструменты без заголовка. Не повторяет ``name`` и не дублирует ``description``.
    title: str
    description: str
    handler: McpToolHandler
    #: Хинты поведения. Заголовок — в :attr:`title`, не здесь.
    annotations: McpToolAnnotations | None = None
    input_schema: dict[str, Any] | None = None
    #: UI по MCP Apps: view на результат и видимость. Без него инструмент такой же, как раньше.
    ui: McpToolUi | None = None


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
    #: Ресурсы сервера (view MCP App). Без них ``resources/*`` сервер не объявляет, как раньше.
    resources: list[McpResourceDef] = field(default_factory=list)
    #: Инструкции сервера — поле ``instructions`` в ответе ``initialize``. Подсказка модели на весь
    #: сервер сразу: когда какой инструмент брать, в каком порядке, чего не делать. Claude и
    #: ChatGPT подмешивают её в контекст модели наравне с описаниями инструментов.
    #:
    #: Текст уходит любому, кто прошёл авторизацию на ``/mcp``, и попадает в промпт чужой модели —
    #: поэтому никаких секретов, внутренних адресов и персональных данных. Строка одна на сервер,
    #: не на пользователя. ``None`` или пусто — поля в ``initialize`` нет, как раньше.
    instructions: str | None = None
