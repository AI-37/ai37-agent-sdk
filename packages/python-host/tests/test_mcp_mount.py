"""Тесты mount-хелперов: derive_authorization_servers, extract_card_url, warn при относит. URL."""

from __future__ import annotations

import importlib.util
import warnings
from dataclasses import dataclass

import pytest
from ai37_agent_sdk import AgentContextSettings, AuthSettings, BillingSettings

from ai37_agent_host.mcp import (
    McpOptions,
    MountMcpOptions,
    derive_authorization_servers,
    extract_card_url,
    mount_mcp,
)

_MCP_INSTALLED = importlib.util.find_spec("mcp") is not None


@dataclass
class _Auth:
    issuer: str | None = None
    issuers: list[object] | None = None


def test_derive_authorization_servers_single_issuer():
    assert derive_authorization_servers(_Auth(issuer="https://iss/")) == ["https://iss/"]


def test_derive_authorization_servers_empty_when_no_issuer():
    assert derive_authorization_servers(_Auth()) == []


def test_derive_authorization_servers_multi_issuer_best_effort():
    @dataclass
    class _Iss:
        issuer: str

    auth = _Auth(issuers=[_Iss("https://a/"), _Iss("https://b/")])
    assert derive_authorization_servers(auth) == ["https://a/", "https://b/"]


def test_extract_card_url_top_level_dict():
    assert extract_card_url({"url": "https://h/a2a/v1"}) == "https://h/a2a/v1"


def test_extract_card_url_from_supported_interfaces():
    card = {"supportedInterfaces": [{"url": "https://h/a2a/v1", "transport": "JSONRPC"}]}
    assert extract_card_url(card) == "https://h/a2a/v1"


def test_extract_card_url_snake_case_interfaces():
    card = {"supported_interfaces": [{"url": "https://h/a2a/v1"}]}
    assert extract_card_url(card) == "https://h/a2a/v1"


def test_extract_card_url_none_when_absent():
    assert extract_card_url({"name": "x"}) is None


def _settings() -> AgentContextSettings:
    return AgentContextSettings(
        auth=AuthSettings(issuer="https://iss/", audience="aud", required=True),
        billing=BillingSettings(base_url="http://billing", apps_auth_token="apps"),
    )


class _FakeApp:
    """Заглушка Starlette-app: только то, что mount_mcp трогает (router.routes, add_middleware)."""

    class _Router:
        def __init__(self) -> None:
            self.routes: list[object] = []

    def __init__(self) -> None:
        self.router = _FakeApp._Router()
        self.middleware: list[tuple] = []

    def add_middleware(self, cls: object, **kwargs: object) -> None:
        self.middleware.append((cls, kwargs))


def _mount_opts(card_url: str) -> MountMcpOptions:
    return MountMcpOptions(
        card_url=card_url,
        card_name="Elevator",
        mcp=McpOptions(tools=[]),
        agent_context=_settings(),
        required=True,
    )


def test_mount_skips_and_warns_on_relative_url():
    app = _FakeApp()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        session_manager = mount_mcp(app, _mount_opts("/a2a/v1"))
    assert session_manager is None
    assert app.router.routes == []  # ничего не смонтировано
    assert app.middleware == []
    assert any("не является абсолютным" in str(w.message) for w in caught)


def test_mount_skips_on_non_http_scheme():
    app = _FakeApp()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert mount_mcp(app, _mount_opts("ftp://h/a2a/v1")) is None
    assert app.router.routes == []


@pytest.mark.skipif(
    _MCP_INSTALLED, reason="без mcp SDK абсолютный URL доходит до create_mcp_asgi_app и падает"
)
def test_mount_absolute_url_reaches_mcp_dependency_error():
    from ai37_agent_host.mcp import MissingMcpDependencyError

    app = _FakeApp()
    # Абсолютный URL проходит проверку origin; резолвы метаданных выполнятся, а сборка
    # MCP-ASGI-приложения упрётся в отсутствие mcp SDK — понятная ошибка.
    with pytest.raises(MissingMcpDependencyError):
        mount_mcp(app, _mount_opts("https://h.app.sp-ai.ru/a2a/v1"))
    # ...при этом публичные metadata-роуты УЖЕ добавлены (они до MCP-сборки).
    assert len(app.router.routes) >= 1
