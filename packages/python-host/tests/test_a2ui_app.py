"""Построитель «A2UI внутри MCP App»; паритет с ``ts-host/test/a2ui-app.test.ts``.

Всё проверяем настоящим клиентом python ``mcp`` SDK поверх сервера хоста — так же, как форму
увидит Claude.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import MagicMock

import pytest
from ai37_a2ui_catalog.mcp_app import A2UI_META_KEY
from ai37_agent_sdk import (
    DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE,
    BillingExecutionDeniedError,
    BillingExecutionRequirement,
    BillingRuntimeState,
    billing_user_message,
)
from mcp import ClientSession
from mcp.shared.exceptions import McpError
from mcp.shared.memory import create_connected_server_and_client_session

from ai37_agent_host.als import HostScope, scope_context
from ai37_agent_host.mcp import (
    A2uiAppBilling,
    A2uiAppTool,
    A2uiStep,
    McpOptions,
    ServerInfo,
    a2ui_app,
    a2ui_view_uri,
    build_mcp_server,
)

VIEW_BASE = "ui://demo/a2ui-surface"
HTML = "<!doctype html><html><body>view v2</body></html>"
REPORT_NODE = {"component": "DemoReport", "props": {"title": "Итог"}}
EDITOR_NODE = {"component": "DemoEditor", "props": {"n": 1}}


def _state(remaining: float = 1e9) -> BillingRuntimeState:
    return BillingRuntimeState(
        org_id="o",
        billing_org_id="b",
        entitlement_status="active",
        remaining_total_tokens=remaining,
    )


def _ctx(assert_allowed: Callable[..., Any] | None = None) -> MagicMock:
    ctx = MagicMock()
    ctx.assert_execution_allowed = MagicMock(side_effect=assert_allowed or (lambda *_a: _state()))
    ctx.report_usage = MagicMock(return_value=None)
    return ctx


def _open(args: dict[str, Any], _ctx: Any) -> A2uiStep[dict[str, int]]:
    n = int(args.get("n", 1))
    return A2uiStep(text=f"Форма открыта, n={n}", node=EDITOR_NODE, state={"n": n})


def _act(name: str, context: dict[str, Any], state: Any, _ctx: Any) -> A2uiStep[dict[str, int]]:
    n = int((state or {}).get("n", 0))
    if name == "boom":
        raise RuntimeError("сломалось")
    if name == "calc":
        return A2uiStep(text=f"Итог: {n * 2}", node=REPORT_NODE, state={"n": n}, calculated=True)
    return A2uiStep(text="Черновик сохранён", state={"n": int(context.get("n", n))})


def _broken(_query: dict[str, Any], _ctx: Any) -> Any:
    raise RuntimeError("нет справочника")


def _billing(**overrides: Any) -> A2uiAppBilling[Any]:
    fields: dict[str, Any] = {
        "enabled": True,
        "requirement": BillingExecutionRequirement(feature="DemoAgent", privilege="DemoAllowed"),
        "metric_code": "demo_calls",
        "total_tokens": 1000,
        "skill_id": lambda step: f"demo-{step.state['n']}",
    }
    fields.update(overrides)
    return A2uiAppBilling(**fields)


def _app(billing: A2uiAppBilling[Any] | None = None) -> Any:
    return a2ui_app(
        view_base=VIEW_BASE,
        html=HTML,
        surface_id="demo",
        view_name="Форма демо-расчёта",
        open=A2uiAppTool(
            name="open_demo_form",
            title="Форма демо-расчёта",
            description="Открывает форму",
            input_schema={"type": "object", "properties": {"n": {"type": "integer"}}},
            run=_open,
        ),
        action=A2uiAppTool(
            name="demo_form_action",
            title="Действие формы демо",
            description="Служебный инструмент формы",
            run=_act,
        ),
        resources={"recommend": lambda q, _c: {"variants": [q.get("n")]}, "broken": _broken},
        billing=billing or _billing(),
        calc_actions=["calc"],
    )


@asynccontextmanager
async def _client(
    ctx: Any, billing: A2uiAppBilling[Any] | None = None
) -> AsyncIterator[ClientSession]:
    app = _app(billing)
    server = build_mcp_server(
        ServerInfo(name="demo", version="1.0.0"),
        McpOptions(tools=app.tools, resources=app.resources),
    )
    with scope_context(HostScope(ctx=ctx)):
        async with create_connected_server_and_client_session(server) as session:
            yield session


def _text(res: Any) -> str:
    return next((b.text for b in res.content if b.type == "text"), "")


def _payload(res: Any) -> dict[str, Any] | None:
    meta = res.meta or {}
    payload: dict[str, Any] | None = meta.get(A2UI_META_KEY)
    return payload


async def _call(session: ClientSession, name: str, args: dict[str, Any]) -> Any:
    return await session.call_tool(name, args)


# ─────────────────────────── инструменты и view ───────────────────────────


async def test_форма_видна_модели_действие_только_view() -> None:
    view_uri = a2ui_view_uri(VIEW_BASE, HTML)
    async with _client(_ctx()) as session:
        tools = {t.name: t for t in (await session.list_tools()).tools}

    assert sorted(tools) == ["demo_form_action", "open_demo_form"]
    assert tools["open_demo_form"].meta == {
        "ui": {"resourceUri": view_uri},
        "ui/resourceUri": view_uri,
    }
    assert tools["demo_form_action"].meta == {
        "ui": {"resourceUri": view_uri, "visibility": ["app"]},
        "ui/resourceUri": view_uri,
    }
    for t in tools.values():
        assert t.annotations is not None
        assert t.annotations.readOnlyHint is True
        # Из формы идёт расчёт с учётом: повтор — новое событие, идемпотентным не объявляем.
        assert t.annotations.idempotentHint is None


def test_адрес_view_несёт_хэш_html() -> None:
    uri = a2ui_view_uri(VIEW_BASE, HTML)
    assert re.fullmatch(r"ui://demo/a2ui-surface-[0-9a-f]{12}\.html", uri)
    assert a2ui_view_uri(VIEW_BASE, HTML + " ") != uri
    # Тот же хэш, что у TS (sha256 от UTF-8): агенты на обоих языках дают одинаковый адрес.
    assert a2ui_view_uri("ui://x/a2ui-surface", "абв") == "ui://x/a2ui-surface-39e305d37ff4.html"


async def test_view_по_текущему_и_прежним_адресам_в_списке_только_текущий() -> None:
    view_uri = a2ui_view_uri(VIEW_BASE, HTML)
    async with _client(_ctx()) as session:
        listed = [str(r.uri) for r in (await session.list_resources()).resources]
        assert listed == [view_uri]
        for uri in (view_uri, f"{VIEW_BASE}.html", f"{VIEW_BASE}-ee8593734650.html"):
            read = await session.read_resource(uri)  # type: ignore[arg-type]
            assert read.contents[0].text == HTML  # type: ignore[union-attr]
        with pytest.raises(McpError):
            await session.read_resource("ui://demo/other.html")  # type: ignore[arg-type]
        with pytest.raises(McpError):
            await session.read_resource(f"{VIEW_BASE}-x/y.html")  # type: ignore[arg-type]


# ─────────────────────────── ход формы и учёт ───────────────────────────


async def test_открытие_поверхность_в_meta_доступ_проверен_учёта_нет() -> None:
    ctx = _ctx()
    async with _client(ctx) as session:
        res = await _call(session, "open_demo_form", {"n": 3})

    payload = _payload(res)
    assert _text(res) == "Форма открыта, n=3"
    assert payload is not None
    assert payload["surfaceId"] == "demo"
    assert payload["actionTool"] == "demo_form_action"
    assert payload["state"] == {"n": 3}
    assert "DemoEditor" in str(payload["messages"])
    ctx.assert_execution_allowed.assert_called_once()
    req = ctx.assert_execution_allowed.call_args.args[0]
    assert (req.feature, req.privilege) == ("DemoAgent", "DemoAllowed")
    ctx.report_usage.assert_not_called()


async def test_расчёт_одно_событие_учёта_со_skill_id_агента() -> None:
    ctx = _ctx()
    async with _client(ctx) as session:
        res = await _call(
            session, "demo_form_action", {"name": "calc", "context": {}, "state": {"n": 4}}
        )

    assert _text(res) == "Итог: 8"
    assert "DemoReport" in str(_payload(res))
    ctx.assert_execution_allowed.assert_called_once()
    ctx.report_usage.assert_called_once()
    kwargs = ctx.report_usage.call_args.kwargs
    assert kwargs["code"] == "demo_calls"
    assert kwargs["properties"] == {"skill_id": "demo-4", "total_tokens": 1000}


async def test_черновик_пустой_поток_без_проверки_и_учёта() -> None:
    ctx = _ctx()
    async with _client(ctx) as session:
        res = await _call(
            session, "demo_form_action", {"name": "draft", "context": {"n": 7}, "state": {"n": 1}}
        )

    payload = _payload(res)
    assert payload is not None
    assert payload["messages"] == []
    assert payload["state"] == {"n": 7}
    ctx.assert_execution_allowed.assert_not_called()
    ctx.report_usage.assert_not_called()


async def test_ресурсный_канал() -> None:
    ctx = _ctx()
    async with _client(ctx) as session:

        async def body(name: str) -> Any:
            res = await _call(session, "demo_form_action", {"name": name, "context": {"n": "5"}})
            return (_payload(res) or {}).get("resource")

        assert await body("resource:recommend") == {"variants": ["5"]}
        assert await body("resource:nope") is None
        assert await body("resource:broken") is None
    ctx.assert_execution_allowed.assert_not_called()


async def test_исключение_в_ходе_is_error_сервер_жив() -> None:
    async with _client(_ctx()) as session:
        res = await _call(session, "demo_form_action", {"name": "boom", "context": {}, "state": {}})
        assert res.isError is True
        assert "сломалось" in _text(res)
        nxt = await _call(session, "open_demo_form", {})
        assert not nxt.isError


# ─────────────────────────── отказ биллинга ───────────────────────────


def _denied(reason: str) -> BillingExecutionDeniedError:
    err = BillingExecutionDeniedError.__new__(BillingExecutionDeniedError)
    Exception.__init__(err, f"BILLING_DENIED[{reason}]: деталь")
    err.reason = reason  # type: ignore[misc]
    return err


def _raise(err: Exception) -> Callable[..., Any]:
    def f(*_a: Any, **_k: Any) -> Any:
        raise err

    return f


@pytest.mark.parametrize(
    ("assert_allowed", "expected"),
    [
        (_raise(_denied("MISSING_FEATURE")), billing_user_message("MISSING_FEATURE", "ru")),
        (_raise(_denied("PAYMENT_FAILED")), billing_user_message("PAYMENT_FAILED", "ru")),
        (lambda *_a: _state(remaining=10), billing_user_message("NO_TOKENS", "ru")),
    ],
    ids=["нет_фичи", "платёж_не_прошёл", "токенов_не_больше_порога"],
)
async def test_отказ_is_error_без_meta_понятный_текст(
    assert_allowed: Callable[..., Any], expected: str
) -> None:
    ctx = _ctx(assert_allowed)
    async with _client(ctx, _billing(min_tokens=10)) as session:
        res = await _call(
            session, "demo_form_action", {"name": "calc", "context": {}, "state": {"n": 1}}
        )

    assert res.isError is True
    assert res.meta is None
    assert _text(res) == expected
    assert "BILLING_DENIED" not in _text(res)
    ctx.report_usage.assert_not_called()


async def test_нет_ctx_общий_текст_отказа() -> None:
    async with _client(None) as session:
        res = await _call(session, "open_demo_form", {})
    assert res.isError is True
    assert res.meta is None
    assert _text(res) == DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE["ru"]


async def test_биллинг_выключен_ни_проверки_ни_учёта() -> None:
    ctx = _ctx()
    async with _client(ctx, _billing(enabled=False)) as session:
        res = await _call(
            session, "demo_form_action", {"name": "calc", "context": {}, "state": {"n": 2}}
        )
    assert not res.isError
    ctx.assert_execution_allowed.assert_not_called()
    ctx.report_usage.assert_not_called()


async def test_сбой_учёта_не_ломает_ответ() -> None:
    ctx = _ctx()
    ctx.report_usage.side_effect = RuntimeError("billing down")
    async with _client(ctx) as session:
        res = await _call(
            session, "demo_form_action", {"name": "calc", "context": {}, "state": {"n": 2}}
        )
    assert not res.isError
    assert _text(res) == "Итог: 4"
