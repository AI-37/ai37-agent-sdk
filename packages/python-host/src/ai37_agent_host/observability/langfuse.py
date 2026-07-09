"""Langfuse-наблюдаемость host'а — порт ``ts-host/src/observability/langfuse.ts``.

«Из коробки» для любого агента на python-host. Реализация на langfuse Python SDK v3 (OpenTelemetry).
Дизайн (см. ``als.py`` / ``a2a_executor.py`` / ``agui.py``):
  - конфиг ТОЛЬКО из env (LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL); выключено → полный no-op;
  - на каждый ход executor зовёт :func:`with_turn_observability` — открывается turn-спан хода
    (session_id=contextId, user_id=claims.sub), активный в OTel-контексте на время ``run()``. И
    langchain ``CallbackHandler`` (без ``root``) автоматически вкладывает LLM/graph-спаны под него;
  - кросс-сервис: turn-спан наследует входящий W3C ``traceparent`` (если оркестратор прокинул его в
    ``message.metadata`` через :func:`inject_trace_context`), иначе — детерминированный trace_id из
    ``metadata.ai37.trace_id`` (фронт владеет id → может поставить score), иначе новый корень;
  - когниция агента прокидывает :func:`current_langfuse_callbacks` в ``invoke``;
  - после хода — ``flush`` (важно для коротко живущих процессов).

langfuse/opentelemetry — soft-import: отсутствие пакетов/ключей просто отключает трассировку
(никогда не роняет ход). В отличие от TS (два бандла → singleton на ``globalThis``), здесь обычный
module-local singleton — Python импортирует модуль единожды.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Any

from ..als import HostLangfuseScope, current_scope
from ..types import Ai37Metadata

logger = logging.getLogger(__name__)

_HEX32 = re.compile(r"^[0-9a-f]{32}$", re.IGNORECASE)

# undefined(=_UNSET) — ещё не инициализировали; None — инициализировали и трассировка выключена.
_UNSET = object()
_client: Any = _UNSET


def _env_bool(value: str | None, default: bool) -> bool:
    if value is None or value == "":
        return default
    return value.lower() in ("true", "1", "yes", "on")


def is_langfuse_enabled() -> bool:
    """Включена ли трассировка прямо сейчас (после первой инициализации)."""
    return _ensure_client() is not None


def _ensure_client() -> Any:
    """Ленивая идемпотентная инициализация langfuse-клиента из env. Безопасна при ошибках."""
    global _client
    if _client is not _UNSET:
        return _client
    enabled = _env_bool(os.environ.get("LANGFUSE_TRACING_ENABLED"), True)
    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY")
    if not enabled or not public_key or not secret_key:
        _client = None
        return None
    try:
        from langfuse import Langfuse

        _client = Langfuse(
            public_key=public_key,
            secret_key=secret_key,
            host=os.environ.get("LANGFUSE_BASE_URL") or os.environ.get("LANGFUSE_HOST"),
            environment=os.environ.get("LANGFUSE_TRACING_ENVIRONMENT"),
            release=os.environ.get("LANGFUSE_RELEASE"),
        )
        logger.info("[ai37-agent-host] Langfuse (OTel) трассировка включена")
    except Exception as exc:  # noqa: BLE001 - трассировка не должна ронять сервис
        logger.warning("[ai37-agent-host] Langfuse отключён: %s", exc)
        _client = None
    return _client


def _make_callback_handler() -> Any:
    try:
        from langfuse.langchain import CallbackHandler

        return CallbackHandler()
    except Exception:  # noqa: BLE001 - langchain-хендлер опционален
        return None


@dataclass
class BeginTurnArgs:
    """Аргументы открытия turn-спана."""

    context_id: str
    task_id: str
    metadata: Ai37Metadata
    claims: Any = None
    agent_name: str = "agent-turn"
    text: str | None = None
    billing_org_id: str | None = None
    #: W3C trace-context входящего A2A (``{traceparent, tracestate?}``) — продолжить трейс.
    parent_carrier: dict[str, str] | None = None


def _trace_context_from_id(raw_id: Any) -> dict[str, str] | None:
    """langfuse ``trace_context`` из клиентского trace_id (фронт владеет id). None, если id нет."""
    if not isinstance(raw_id, str) or not raw_id:
        return None
    return {"trace_id": raw_id.lower()} if _HEX32.match(raw_id) else None


async def with_turn_observability(
    args: BeginTurnArgs,
    run: Any,
    to_output: Any = None,
) -> Any:
    """Открыть turn-спан, активный в OTel на время ``run()``. No-op если трассировка off."""
    client = _ensure_client()
    if client is None:
        return await run()

    from opentelemetry import context as otel_context
    from opentelemetry import propagate

    parent_ctx = propagate.extract(args.parent_carrier) if args.parent_carrier else None
    trace_context = None if parent_ctx else _trace_context_from_id(args.metadata.trace_id)
    tags = [t for t in (args.metadata.channel, args.metadata.app_id) if t]

    token = otel_context.attach(parent_ctx) if parent_ctx is not None else None
    try:
        span_cm = (
            client.start_as_current_observation(name=args.agent_name, trace_context=trace_context)
            if trace_context
            else client.start_as_current_observation(name=args.agent_name)
        )
        with span_cm as span:
            _apply_trace_attributes(client, args, tags)
            handler = _make_callback_handler()
            trace_id = _current_trace_id(client)
            scope = current_scope()
            if scope is not None:
                scope.langfuse = HostLangfuseScope(trace_id=trace_id, span=span, handler=handler)
            result = await run()
            if to_output is not None:
                out = to_output(result)
                if isinstance(out, dict):
                    span.update(output=out)
            return result
    finally:
        if token is not None:
            otel_context.detach(token)
        try:
            client.flush()
        except Exception:  # noqa: BLE001
            pass


def _apply_trace_attributes(client: Any, args: BeginTurnArgs, tags: list[str]) -> None:
    """session_id/user_id/metadata/tags → trace через propagate_attributes (если доступен)."""
    metadata = {
        "taskId": args.task_id,
        "contextId": args.context_id,
        "channel": args.metadata.channel,
        "app_id": args.metadata.app_id,
        "intent": args.metadata.intent.skill if args.metadata.intent else None,
        "billing_org_id": args.billing_org_id,
        "tenant": args.metadata.tenant,
    }
    user_id = getattr(args.claims, "sub", None) if args.claims is not None else None
    try:
        from langfuse import propagate_attributes

        cm = propagate_attributes(
            session_id=args.context_id or None,
            user_id=user_id,
            metadata=metadata,
            tags=tags or None,
        )
        cm.__enter__()  # держим на весь ход — закроется с turn-спаном (см. TS span.update)
    except Exception:  # noqa: BLE001 - атрибуты не критичны для хода
        pass


def _current_trace_id(client: Any) -> str | None:
    try:
        return client.get_current_trace_id()
    except Exception:  # noqa: BLE001
        return None


def inject_trace_context() -> dict[str, str]:
    """W3C trace-context активного OTel-спана как carrier — для проброса вниз по A2A.

    Sync; ``{}`` если трассировка выключена/не инициализирована. Зовётся из relay при сборке
    исходящего сообщения (внутри активного turn/remote-a2a спана).
    """
    if _ensure_client() is None:
        return {}
    carrier: dict[str, str] = {}
    try:
        from opentelemetry import propagate

        propagate.inject(carrier)
    except Exception:  # noqa: BLE001 - трассировка не должна влиять на ход
        pass
    return carrier


async def with_remote_a2a_observability(agent_id: str, run: Any) -> Any:
    """Обернуть исходящий remote-A2A вызов в спан ``remote-a2a:<agentId>``, чтобы
    :func:`inject_trace_context` захватил ИМЕННО его (иначе суб-агент повиснет в корне трейса)."""
    client = _ensure_client()
    if client is None:
        return await run()
    with client.start_as_current_observation(name=f"remote-a2a:{agent_id}") as span:
        try:
            span.update(metadata={"agentId": agent_id, "kind": "remote-a2a"})
        except Exception:  # noqa: BLE001
            pass
        return await run()
