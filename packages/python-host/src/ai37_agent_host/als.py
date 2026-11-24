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

from ai37_agent_sdk import AgentContext, resolve_request_locale, user_locale_instruction

from .user_instructions import user_instructions_block


@dataclass
class HostLangfuseScope:
    """Срез Langfuse одного хода (см. ``observability/langfuse.py``)."""

    trace_id: str | None = None
    #: Активный turn-спан (типизирован ``Any`` — чтобы host не тянул langfuse в обязательные deps).
    span: Any = None
    #: LangChain CallbackHandler текущего хода.
    handler: Any = None


@dataclass
class HostTurn:
    """Диалог и ход текущего запроса.

    A2A ``context_id``/``task_id``; на AG-UI оба равны ``thread_id``.
    """

    context_id: str
    task_id: str


@dataclass
class HostScope:
    ctx: AgentContext | None = None
    bearer: str | None = None
    #: Формат текста из нативного A2A ``params.configuration`` / AG-UI ``forwardedProps.ai37``.
    accepted_output_modes: list[str] | None = None
    #: Каталоги A2UI клиента (``a2uiClientCapabilities.v0.9.supportedCatalogIds``).
    supported_catalog_ids: list[str] | None = None
    #: LangGraph-чекпоинтер, предоставленный ХОСТОМ (durable графовое состояние по ``thread_id``).
    #: Host кладёт его из ``create_agent_host(checkpointer=...)`` через ``AuthGuardMiddleware``;
    #: когниция агента забирает через :func:`current_checkpointer` и цепляет в свой граф
    #: (``graph.compile(checkpointer=...)``). Типизирован ``Any`` — чтобы host НЕ тянул langgraph в
    #: обязательные deps (как ``langfuse``/``task_store``). Это ДРУГОЙ уровень, чем A2A task-store
    #: (состояние хода/HITL): checkpointer — состояние графа.
    checkpointer: Any = None
    langfuse: HostLangfuseScope | None = None
    #: Диалог и ход: кладут executor и AG-UI-роутер до вызова handler'а, независимо от трассировки.
    #: Нужны вызовам «от имени хода» без проброса через сигнатуры (:func:`publish_artifact`).
    turn: HostTurn | None = None
    #: Локаль хода (тег BCP-47), разрешённая хостом: ``metadata.ai37.locale`` → claim ``locale``
    #: → claim ``org_locale`` → ``ru``. Кладут executor и AG-UI-роутер; читает
    #: :func:`current_locale`.
    locale: str | None = None
    #: Персональные инструкции пользователя (``metadata.ai37.user_instructions``), уже
    #: нормализованные. Кладёт только A2A-executor: значение ставит оркестратор из своей БД. Из
    #: ``forwardedProps`` браузера AG-UI-роутер его не берёт — иначе клиент обошёл бы проверку при
    #: сохранении. Читает :func:`current_user_instructions`.
    user_instructions: str | None = None


_request_scope: contextvars.ContextVar[HostScope | None] = contextvars.ContextVar(
    "ai37_agent_host_scope", default=None
)

#: Ключ scope запроса в ``ServerCallContext.state``. ContextVar в A2A-ход доезжает не всегда:
#: незавершённую задачу a2a-sdk ведёт один долгоживущий producer, созданный ``asyncio.create_task``
#: на ПЕРВОМ запросе, — он навсегда унаследовал contextvars того запроса, а следующие ходы получает
#: через очередь. Поэтому scope едет вместе с запросом: кладёт ``HostCallContextBuilder`` (он
#: работает внутри HTTP-запроса, за guard'ом), восстанавливает ``HostExecutor.execute``.
CALL_CONTEXT_SCOPE_KEY = "ai37/host-scope"


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


def current_turn_context() -> HostTurn | None:
    """Диалог и ход текущего запроса или ``None`` вне хода."""
    scope = _request_scope.get()
    return scope.turn if scope else None


def current_checkpointer() -> Any:
    """LangGraph-чекпоинтер текущего хода (host-предоставленный) или ``None``.

    Когниция агента цепляет его в свой граф: ``graph.compile(checkpointer=current_checkpointer())``.
    Вне turn-scope (или host без ``checkpointer``) → ``None`` (граф без durable-состояния).
    """
    scope = _request_scope.get()
    return scope.checkpointer if scope else None


def current_locale() -> str:
    """Локаль текущего хода (тег BCP-47, без обрезки: ``es-MX`` остаётся ``es-MX``).

    Вне хода и на путях, где host её не положил (MCP), — из claims verified-контекста, иначе
    ``ru``, как было до локали. Детерминированные строки агента: ``t(current_locale(), {...})``.
    """
    scope = _request_scope.get()
    if scope is not None and scope.locale:
        return scope.locale
    claims = scope.ctx.claims if scope is not None and scope.ctx is not None else None
    return resolve_request_locale(None, claims)


def with_user_locale(system_prompt: str, locale: str | None = None) -> str:
    """Дописать к системному промпту секцию о языке ответа (docs#589 §1).

    Отвечать на языке пользователя и по возможности рассуждать на нём же, а цитаты норм, названия
    документов и ссылки «[название, пункт]» оставлять в оригинале. Секция видна и в запросе к LLM,
    и в трейсе; сам промпт остаётся на русском. ``locale`` не задан — локаль хода
    (:func:`current_locale`). Язык вне ``SUPPORTED_LOCALES`` (``pl``) называется тегом.
    """
    return f"{system_prompt}\n\n{user_locale_instruction(locale or current_locale())}"


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


def current_user_instructions() -> str | None:
    """Персональные инструкции пользователя текущего хода (нормализованные) или ``None``."""
    scope = _request_scope.get()
    return scope.user_instructions if scope else None


#: Сентинел «аргумент не передан»: явный ``None`` значит «инструкций нет», а не «возьми из хода».
_FROM_SCOPE: Any = object()


def with_user_instructions(system_prompt: str, text: str | None = _FROM_SCOPE) -> str:
    """Дописать к системному промпту блок «Предпочтения пользователя» (docs#740).

    Низший приоритет: после правил агента и инструкции владельца. Агент зовёт её там же, где
    :func:`with_user_locale`: ``with_user_instructions(with_user_locale(base_prompt))``. Нет
    инструкций → промпт не меняется.

    ``text`` не передан — инструкции хода (:func:`current_user_instructions`). Передан явно, даже
    ``None`` или ``""``, — scope не читается: так оркестратор, который берёт инструкции из своей БД,
    не подхватит клиентские из A2A-конверта, когда в БД пусто.
    """
    block = user_instructions_block(current_user_instructions() if text is _FROM_SCOPE else text)
    return f"{system_prompt}\n\n{block}" if block else system_prompt
