"""Тесты host-фабрики LLM (resolve_llm_config / create_openai_client)."""

import importlib.util
from dataclasses import dataclass

import pytest

from ai37_agent_host.als import HostScope, scope_context
from ai37_agent_host.llm import (
    LITELLM_BASE_URL_ENV,
    LLM_MAX_RETRIES,
    LLM_TIMEOUT_S,
    LlmConfigurationError,
    _without_rate_limit_retry,
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
    # Паритет с Ai37ChatCompletions: 180 с на попытку, один повтор.
    assert (cfg.timeout, cfg.max_retries) == (LLM_TIMEOUT_S, LLM_MAX_RETRIES) == (180.0, 1)


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


@dataclass
class _Resp:
    status_code: int


class _FakeSdkClient:
    """Базовый клиент с логикой повторов как у OpenAI SDK: 408/409/429/5xx — повторять."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def _should_retry(self, response):
        return response.status_code in (408, 409, 429) or response.status_code >= 500


def test_rate_limit_not_retried_rest_left_to_sdk():
    client = _without_rate_limit_retry(_FakeSdkClient)(api_key="k")
    assert client.kwargs == {"api_key": "k"}
    assert client._should_retry(_Resp(429)) is False
    assert client._should_retry(_Resp(500)) is True
    assert client._should_retry(_Resp(408)) is True
    assert client._should_retry(_Resp(400)) is False


@pytest.mark.skipif(importlib.util.find_spec("openai") is None, reason="openai не установлен")
def test_real_client_does_not_retry_429():  # pragma: no cover - зависит от окружения
    import httpx

    client = create_openai_client(api_key="k", base_url="http://x")
    assert client.max_retries == 1
    assert client._should_retry(httpx.Response(429)) is False
    assert client._should_retry(httpx.Response(503)) is True
