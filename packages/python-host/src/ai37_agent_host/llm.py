"""LLM-клиент host'а — из ``ctx.llm_key`` + ``LITELLM_BASE_URL`` (замена ai37-chat-completions.ts).

``ai37-chat-completions.ts`` — langchain-сабкласс, глушащий локальный подсчёт токенов (BPE-таблицы
tiktoken виснут на IPv6-egress из кластера — специфика JS). В Python зависания нет, поэтому здесь
не сабкласс, а тонкая фабрика OpenAI-совместимого клиента: секрет (per-org LiteLLM-ключ) берётся из
request-scope (``ctx.llm_key``), endpoint — из ``LITELLM_BASE_URL``. ``openai`` — soft-import: host
не зависит от него жёстко, а агент-потребитель (напр. Minstroy) держит ``openai`` в своих deps.

Повторы и таймаут — как у ``Ai37ChatCompletions``: 180 с на попытку, один повтор, без повтора 429.
429 до клиента доходит, только когда шлюз LiteLLM уже выждал ``Retry-After`` провайдера и сдался;
повтор отсюда снова встанет в очередь лимита. Остальные решения о повторе — за OpenAI SDK.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from .als import current_ctx

LITELLM_BASE_URL_ENV = "LITELLM_BASE_URL"
# Шлюз при 429 ждёт ``Retry-After`` до 2 × 60 с, плюс сам ответ.
LLM_TIMEOUT_S = 180.0
LLM_MAX_RETRIES = 1


class LlmConfigurationError(RuntimeError):
    """LLM-ключ/endpoint недоступны в текущем ходе (нет billing-state или пуст env)."""


@dataclass
class LlmConfig:
    """Разрешённая конфигурация вызова LLM (секрет — не логировать)."""

    api_key: str
    base_url: str
    model: str | None = None
    timeout: float = LLM_TIMEOUT_S
    max_retries: int = LLM_MAX_RETRIES


def resolve_llm_config(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    timeout: float = LLM_TIMEOUT_S,
    max_retries: int = LLM_MAX_RETRIES,
) -> LlmConfig:
    """(api_key, base_url) из request-scope ctx.llm_key + LITELLM_BASE_URL (или явных override)."""
    key = api_key or _ctx_llm_key()
    if not key:
        raise LlmConfigurationError(
            "LLM-ключ недоступен: нет ctx.llm_key в request-scope (billing-state пуст?)"
        )
    url = (base_url or os.environ.get(LITELLM_BASE_URL_ENV) or "").rstrip("/")
    if not url:
        raise LlmConfigurationError(f"LLM endpoint не задан: пуст {LITELLM_BASE_URL_ENV}")
    return LlmConfig(
        api_key=key, base_url=url, model=model, timeout=timeout, max_retries=max_retries
    )


def _ctx_llm_key() -> str | None:
    ctx = current_ctx()
    return getattr(ctx, "llm_key", None) if ctx else None


def create_openai_client(config: LlmConfig | None = None, **overrides: Any) -> Any:
    """``AsyncOpenAI`` из :func:`resolve_llm_config`. ``openai`` — soft-import (deps агента)."""
    cfg = config or resolve_llm_config(**overrides)
    try:
        from openai import AsyncOpenAI
    except ModuleNotFoundError as exc:  # pragma: no cover - зависит от окружения агента
        raise LlmConfigurationError(
            "Пакет 'openai' не установлен — добавьте его в зависимости агента-потребителя"
        ) from exc
    return _without_rate_limit_retry(AsyncOpenAI)(
        api_key=cfg.api_key,
        base_url=cfg.base_url,
        timeout=cfg.timeout,
        max_retries=cfg.max_retries,
    )


def _without_rate_limit_retry(client_cls: Any) -> Any:
    """Сабкласс клиента OpenAI SDK без повтора 429; остальное решает ``_should_retry`` SDK."""

    class _Client(client_cls):  # type: ignore[misc, valid-type]
        def _should_retry(self, response: Any) -> bool:
            if response.status_code == 429:
                return False
            return bool(super()._should_retry(response))

    return _Client
