"""LLM-клиент host'а — из ``ctx.llm_key`` + ``LITELLM_BASE_URL`` (замена ai37-chat-completions.ts).

``ai37-chat-completions.ts`` — langchain-сабкласс, глушащий локальный подсчёт токенов (BPE-таблицы
tiktoken виснут на IPv6-egress из кластера — специфика JS). В Python зависания нет, поэтому здесь
не сабкласс, а тонкая фабрика OpenAI-совместимого клиента: секрет (per-org LiteLLM-ключ) берётся из
request-scope (``ctx.llm_key``), endpoint — из ``LITELLM_BASE_URL``. ``openai`` — soft-import: host
не зависит от него жёстко, а агент-потребитель (напр. Minstroy) держит ``openai`` в своих deps.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from .als import current_ctx

LITELLM_BASE_URL_ENV = "LITELLM_BASE_URL"


class LlmConfigurationError(RuntimeError):
    """LLM-ключ/endpoint недоступны в текущем ходе (нет billing-state или пуст env)."""


@dataclass
class LlmConfig:
    """Разрешённая конфигурация вызова LLM (секрет — не логировать)."""

    api_key: str
    base_url: str
    model: str | None = None
    timeout: float = 30.0
    max_retries: int = 3


def resolve_llm_config(
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    timeout: float = 30.0,
    max_retries: int = 3,
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
    return AsyncOpenAI(
        api_key=cfg.api_key,
        base_url=cfg.base_url,
        timeout=cfg.timeout,
        max_retries=cfg.max_retries,
    )
