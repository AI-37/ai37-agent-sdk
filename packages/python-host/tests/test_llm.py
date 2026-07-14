"""Тесты host-фабрики LLM (resolve_llm_config / create_openai_client)."""

import importlib.util
from dataclasses import dataclass

import pytest

from ai37_agent_host.als import HostScope, scope_context
from ai37_agent_host.llm import (
    LITELLM_BASE_URL_ENV,
    LlmConfigurationError,
    create_openai_client,
    resolve_llm_config,
)


@dataclass
class _FakeCtx:
    llm_key: str | None


def test_resolve_from_explicit_overrides():
    cfg = resolve_llm_config(api_key="k1", base_url="http://litellm/", model="gpt-4o")
    assert cfg.api_key == "k1"
    assert cfg.base_url == "http://litellm"  # trailing slash срезан
    assert cfg.model == "gpt-4o"
    assert (cfg.timeout, cfg.max_retries) == (30.0, 3)


def test_resolve_from_ctx_and_env(monkeypatch):
    monkeypatch.setenv(LITELLM_BASE_URL_ENV, "http://env-litellm/v1/")
    with scope_context(HostScope(ctx=_FakeCtx(llm_key="sk-org"))):
        cfg = resolve_llm_config()
    assert cfg.api_key == "sk-org"
    assert cfg.base_url == "http://env-litellm/v1"


def test_missing_key_raises(monkeypatch):
    monkeypatch.setenv(LITELLM_BASE_URL_ENV, "http://x")
    with pytest.raises(LlmConfigurationError, match="ключ"):
        resolve_llm_config()


def test_missing_url_raises(monkeypatch):
    monkeypatch.delenv(LITELLM_BASE_URL_ENV, raising=False)
    with pytest.raises(LlmConfigurationError, match="endpoint"):
        resolve_llm_config(api_key="k")


def test_create_client_soft_import():
    if importlib.util.find_spec("openai") is None:
        with pytest.raises(LlmConfigurationError, match="openai"):
            create_openai_client(api_key="k", base_url="http://x")
    else:  # pragma: no cover - зависит от окружения
        client = create_openai_client(api_key="k", base_url="http://x")
        assert str(client.base_url).startswith("http://x")
