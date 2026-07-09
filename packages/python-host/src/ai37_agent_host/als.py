"""Request-scope через ``contextvars`` — порт ``ts-host/src/als.ts``.

JWT-guard кладёт сюда verified :class:`AgentContext`; executor/handler читают, не
завязываясь на внутренний auth-API ``a2a-sdk``. ``AsyncLocalStorage`` (Node) → ``ContextVar``
(Python): значение автоматически наследуется дочерними задачами/``await`` в рамках одного scope.
"""

from __future__ import annotations

import contextvars
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from ai37_agent_sdk import AgentContext


@dataclass
class HostLangfuseScope:
    """Срез Langfuse одного хода (см. ``observability/langfuse.py``)."""

    trace_id: str | None = None
    #: Активный turn-спан (типизирован ``Any`` — чтобы host не тянул langfuse в обязательные deps).
    span: Any = None
    #: LangChain CallbackHandler текущего хода.
    handler: Any = None


@dataclass
class HostScope:
    ctx: AgentContext | None = None
    bearer: str | None = None
    #: Формат текста из нативного A2A ``params.configuration`` / AG-UI ``forwardedProps.ai37``.
    accepted_output_modes: list[str] | None = None
    #: Каталоги A2UI клиента (``a2uiClientCapabilities.v0.9.supportedCatalogIds``).
    supported_catalog_ids: list[str] | None = None
    langfuse: HostLangfuseScope | None = None


_request_scope: contextvars.ContextVar[HostScope | None] = contextvars.ContextVar(
    "ai37_agent_host_scope", default=None
)


def set_scope(scope: HostScope) -> contextvars.Token[HostScope | None]:
    """Установить scope текущего request'а (guard). Вернёт token для :func:`reset_scope`."""
    return _request_scope.set(scope)


def reset_scope(token: contextvars.Token[HostScope | None]) -> None:
    _request_scope.reset(token)


@contextmanager
def scope_context(scope: HostScope) -> Iterator[HostScope]:
    """``with scope_context(scope): ...`` — аналог ``requestScope.run(scope, fn)`` из TS."""
    token = _request_scope.set(scope)
    try:
        yield scope
    finally:
        _request_scope.reset(token)


def current_scope() -> HostScope | None:
    return _request_scope.get()


def current_ctx() -> AgentContext | None:
    scope = _request_scope.get()
    return scope.ctx if scope else None


def current_bearer() -> str | None:
    scope = _request_scope.get()
    return scope.bearer if scope else None


def current_accepted_output_modes() -> list[str] | None:
    scope = _request_scope.get()
    return scope.accepted_output_modes if scope else None


def current_supported_catalog_ids() -> list[str] | None:
    scope = _request_scope.get()
    return scope.supported_catalog_ids if scope else None


def current_trace_id() -> str | None:
    scope = _request_scope.get()
    return scope.langfuse.trace_id if scope and scope.langfuse else None


def current_langfuse_trace() -> Any:
    scope = _request_scope.get()
    return scope.langfuse.span if scope and scope.langfuse else None


def current_langfuse_handler() -> Any:
    scope = _request_scope.get()
    return scope.langfuse.handler if scope and scope.langfuse else None


def current_langfuse_callbacks() -> list[Any]:
    """``[handler]`` если трассировка включена, иначе ``[]`` — для LangChain ``callbacks=``."""
    scope = _request_scope.get()
    handler = scope.langfuse.handler if scope and scope.langfuse else None
    return [handler] if handler else []
