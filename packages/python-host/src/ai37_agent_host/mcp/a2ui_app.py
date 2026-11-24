"""Построитель «A2UI внутри MCP App» — порт ``ts-host/src/mcp/a2ui-app.ts``.

Агент даёт чистые функции хода формы, построитель — всё, что про транспорт: инструмент формы,
app-only инструмент действий, ресурс view, ресурсный канал ``resource:<id>``, проверку доступа и
учёт (plans/mcp-apps-agent-host-keo-thermal.md, срез 1). Поток ``_meta["ai37/a2ui"]`` собирают
помощники ``ai37_a2ui_catalog.mcp_app`` — пакет подгружается лениво (extra ``a2ui``), его
берёт агент вместе с HTML view.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

from ai37_agent_sdk import (
    DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE,
    AgentContext,
    BillingExecutionRequirement,
    billing_user_message,
    friendly_billing_message,
    t,
)

from ..als import current_locale
from .types import (
    McpResourceDef,
    McpResourceUi,
    McpToolAnnotations,
    McpToolDef,
    McpToolResult,
    McpToolUi,
)

S = TypeVar("S")


@dataclass
class A2uiStep(Generic[S]):
    """Один ход формы: текст для модели, узел для view, новое состояние документа.

    Зеркало TS ``A2uiStep``. ``node`` — ``{"component": ..., "props": {...}}``; нет у черновика —
    поверхность во view не пересоздаётся. ``calculated`` — единственный ход, который учитывается.
    """

    text: str
    state: S
    calculated: bool = False
    node: dict[str, Any] | None = None
    #: Полный протокол: его отдают структурные инструменты агента, форме он не нужен.
    report: str | None = None


@dataclass
class A2uiAppBilling(Generic[S]):
    """Учёт и проверка доступа MCP-пути агента — те же, что у его A2A-пути."""

    enabled: bool
    requirement: BillingExecutionRequirement
    #: ``BILLING_METRIC_CODE`` агента.
    metric_code: str
    #: ``skill_id`` события — тот же, что у структурного инструмента: для учёта это один расчёт.
    skill_id: Callable[[A2uiStep[S]], str]
    #: Остаток токенов ``<= min_tokens`` — отказ «нет ресурсов».
    min_tokens: float = 0
    #: ``properties.total_tokens`` события, если агент его шлёт.
    total_tokens: int | None = None


@dataclass
class McpBilling:
    """Проверка доступа и учёт по правилам построителя — для структурных инструментов агента."""

    check: Callable[[AgentContext | None], Awaitable[McpToolResult | None]]
    meter: Callable[[AgentContext | None, str], Awaitable[None]]


ResourceRead = Callable[[dict[str, Any], AgentContext | None], Any]


@dataclass
class A2uiAppTool:
    """Инструмент формы или действий: имя, заголовок, описание и функция хода.

    ``run`` формы — ``(args, ctx)``, ``run`` действий — ``(name, context, state, ctx)``; оба sync
    или async и отдают :class:`A2uiStep`.
    """

    name: str
    title: str
    description: str
    run: Callable[..., Any]
    #: JSON Schema аргументов — только у инструмента формы; у действий она фиксирована.
    input_schema: dict[str, Any] | None = None


@dataclass
class A2uiApp:
    tools: list[McpToolDef]
    resources: list[McpResourceDef]
    #: Адрес view с хэшем — им же помечают свои структурные инструменты (``ui.resource_uri``).
    view_uri: str
    billing: McpBilling


@dataclass
class _Options:
    view_base: str
    html: str
    surface_id: str
    open: A2uiAppTool
    action: A2uiAppTool
    billing: A2uiAppBilling[Any]
    calc_actions: set[str]
    resources: dict[str, ResourceRead] = field(default_factory=dict)
    view_name: str = "Форма и отчёт расчёта"


#: Аргументы app-only инструмента: действие поверхности, его контекст и состояние документа.
_ACTION_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "Имя действия поверхности"},
        "context": {"type": "object", "additionalProperties": True, "default": {}},
        "state": {},
    },
    "required": ["name"],
}


def a2ui_view_uri(view_base: str, html: str) -> str:
    """Адрес view ``{view_base}-{sha256(html)[:12]}.html``: новый HTML — новый адрес.

    Кэш хоста не держит старую форму. Хэш тот же, что у TS ``a2uiViewUri``.
    """
    digest = hashlib.sha256(html.encode("utf-8")).hexdigest()[:12]
    return f"{view_base}-{digest}.html"


def _text_result(text: str, *, is_error: bool = False) -> McpToolResult:
    return McpToolResult(content=[{"type": "text", "text": text}], is_error=is_error)


async def _resolve(value: Any) -> Any:
    return await value if isinstance(value, Awaitable) else value


def mcp_billing(billing: A2uiAppBilling[Any]) -> McpBilling:
    """Проверка доступа и учёт MCP-пути. Зеркало TS ``mcpBilling``.

    Тексты отказа — из ``ai37_agent_sdk`` на языке хода: пользователь внешнего хоста видит
    понятное «нет доступа» или «закончились токены», а не технический ``BILLING_DENIED: …``.
    """

    async def check(ctx: AgentContext | None) -> McpToolResult | None:
        if not billing.enabled:
            return None
        locale = current_locale()
        if ctx is None:
            return _text_result(t(locale, DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE), is_error=True)
        try:
            state = await _resolve(ctx.assert_execution_allowed(billing.requirement))
        except Exception as e:  # noqa: BLE001 - любой отказ биллинга — текст пользователю
            return _text_result(friendly_billing_message(e, locale), is_error=True)
        if state.remaining_total_tokens <= billing.min_tokens:
            return _text_result(billing_user_message("NO_TOKENS", locale), is_error=True)
        return None

    async def meter(ctx: AgentContext | None, skill_id: str) -> None:
        if not billing.enabled or ctx is None:
            return
        properties: dict[str, Any] = {"skill_id": skill_id}
        if billing.total_tokens is not None:
            properties["total_tokens"] = billing.total_tokens
        try:
            await _resolve(
                ctx.report_usage(
                    transaction_id=str(uuid.uuid4()),
                    code=billing.metric_code,
                    properties=properties,
                )
            )
        except Exception:  # noqa: BLE001, S110 - учёт best-effort: ответ уже посчитан
            pass

    return McpBilling(check=check, meter=meter)


def _load_mcp_app() -> Any:
    try:
        from ai37_a2ui_catalog import mcp_app
    except ImportError as e:  # pragma: no cover - зависит от окружения
        raise ImportError(
            "a2ui_app: нужен пакет ai37-a2ui-catalog (pip install 'ai37-agent-host[a2ui]') — "
            "он собирает поток A2UI для view"
        ) from e
    return mcp_app


def _from_dict(result: dict[str, Any]) -> McpToolResult:
    return McpToolResult(content=result["content"], meta=result["_meta"])


class _Builder:
    """Состояние одного построителя: опции, биллинг и помощники протокола каталога."""

    def __init__(self, opts: _Options) -> None:
        self.opts = opts
        self.view_uri = a2ui_view_uri(opts.view_base, opts.html)
        self.billing = mcp_billing(opts.billing)
        self.protocol = _load_mcp_app()

    def step_result(self, step: A2uiStep[Any]) -> McpToolResult:
        common: dict[str, Any] = {
            "text": step.text,
            "surface_id": self.opts.surface_id,
            "action_tool": self.opts.action.name,
            "state": step.state,
        }
        if step.node is not None:
            return _from_dict(self.protocol.a2ui_app_result(node=step.node, **common))
        return _from_dict(self.protocol.a2ui_app_result(messages=[], **common))

    async def run_step(self, run: Callable[[], Any], ctx: AgentContext | None) -> McpToolResult:
        """Ход, который может быть расчётом: учёт — ровно одно событие на выполненный расчёт."""
        try:
            step: A2uiStep[Any] = await _resolve(run())
        except Exception as e:  # noqa: BLE001 - исключение хода — текст модели и view
            return _text_result(f"Ошибка: {e}", is_error=True)
        if step.calculated:
            await self.billing.meter(ctx, self.opts.billing.skill_id(step))
        return self.step_result(step)

    async def resource(
        self, resource_id: str, query: dict[str, Any], ctx: AgentContext | None
    ) -> McpToolResult:
        read = self.opts.resources.get(resource_id)
        if read is None:
            return _from_dict(self.protocol.a2ui_resource_result(None))
        try:
            body = await _resolve(read(query, ctx))
        except Exception:  # noqa: BLE001 - view отдаст блоку 404, как ручка ресурса на ошибку
            body = None
        return _from_dict(self.protocol.a2ui_resource_result(body))

    async def open_handler(self, args: dict[str, Any], ctx: AgentContext | None) -> McpToolResult:
        deny = await self.billing.check(ctx)
        if deny is not None:
            return deny
        return await self.run_step(lambda: self.opts.open.run(args, ctx), ctx)

    async def action_handler(self, args: dict[str, Any], ctx: AgentContext | None) -> McpToolResult:
        name = str(args.get("name") or "")
        context = args.get("context") or {}
        resource_id = self.protocol.parse_resource_action_name(name)
        if resource_id is not None:
            return await self.resource(resource_id, context, ctx)
        # Черновик, навигация и подбор шлются часто и ничего не стоят — медленный /state не дёргаем.
        if name in self.opts.calc_actions:
            deny = await self.billing.check(ctx)
            if deny is not None:
                return deny
        state = args.get("state")
        return await self.run_step(lambda: self.opts.action.run(name, context, state, ctx), ctx)

    def build(self) -> A2uiApp:
        o = self.opts
        open_tool = McpToolDef(
            name=o.open.name,
            title=o.open.title,
            description=o.open.description,
            handler=self.open_handler,
            # Без idempotent_hint: из формы идёт расчёт с учётом, повтор — новое событие.
            annotations=McpToolAnnotations(read_only_hint=True),
            input_schema=o.open.input_schema,
            ui=McpToolUi(resource_uri=self.view_uri),
        )
        action_tool = McpToolDef(
            name=o.action.name,
            title=o.action.title,
            description=o.action.description,
            handler=self.action_handler,
            annotations=McpToolAnnotations(read_only_hint=True),
            input_schema=_ACTION_INPUT_SCHEMA,
            ui=McpToolUi(resource_uri=self.view_uri, visibility=["app"]),
        )
        view = McpResourceDef(
            uri=self.view_uri,
            uri_prefix=o.view_base,
            name=o.view_name,
            description="Поверхность каталога A2UI AI37 внутри MCP App",
            read=lambda: o.html,
            ui=McpResourceUi(prefers_border=True),
        )
        return A2uiApp(
            tools=[open_tool, action_tool],
            resources=[view],
            view_uri=self.view_uri,
            billing=self.billing,
        )


def a2ui_app(
    *,
    view_base: str,
    html: str,
    surface_id: str,
    open: A2uiAppTool,  # noqa: A002 - имя поля как в TS-контракте
    action: A2uiAppTool,
    billing: A2uiAppBilling[Any],
    calc_actions: Iterable[str],
    resources: dict[str, ResourceRead] | None = None,
    view_name: str | None = None,
) -> A2uiApp:
    """Инструмент формы, app-only инструмент действий и ресурс view. Зеркало TS ``a2uiApp``.

    ``open.run(args, ctx)`` и ``action.run(name, context, state, ctx)`` — sync или async, отдают
    :class:`A2uiStep`. Ресурс view отвечает и на прежние адреса ``{view_base}<хвост>``: хост
    кэширует ``tools/list`` и после выхода нового HTML спрашивает форму по старому адресу.
    """
    opts = _Options(
        view_base=view_base,
        html=html,
        surface_id=surface_id,
        open=open,
        action=action,
        billing=billing,
        calc_actions=set(calc_actions),
        resources=dict(resources or {}),
        view_name=view_name or "Форма и отчёт расчёта",
    )
    return _Builder(opts).build()


__all__ = [
    "A2uiApp",
    "A2uiAppBilling",
    "A2uiAppTool",
    "A2uiStep",
    "McpBilling",
    "a2ui_app",
    "a2ui_view_uri",
    "mcp_billing",
]
