"""Langfuse-наблюдаемость host'а — порт ``ts-host/src/observability/langfuse.ts``.

«Из коробки» для любого агента на python-host. Реализация на langfuse Python SDK v5 (OpenTelemetry),
ставится extra ``ai37-agent-host[observability]``.
Дизайн (см. ``als.py`` / ``a2a_executor.py`` / ``agui.py``):
  - конфиг ТОЛЬКО из env (LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASE_URL); выключено → полный no-op;
  - на каждый ход (A2A-executor и AG-UI-роутер) зовётся :func:`with_turn_observability` —
    открывается turn-спан хода (session_id=contextId, user_id=claims.sub), активный в OTel-контексте
    на время ``run()``. И langchain ``CallbackHandler`` (без ``root``) автоматически вкладывает
    LLM/graph-спаны под него;
  - кросс-сервис: turn-спан наследует входящий W3C ``traceparent`` (если оркестратор прокинул его в
    ``message.metadata`` через :func:`inject_trace_context`), иначе — детерминированный trace_id из
    ``metadata.ai37.trace_id`` (фронт владеет id → может поставить score), иначе новый корень;
  - когниция агента прокидывает :func:`current_langfuse_callbacks` в ``invoke``;
  - после хода — ``flush`` в фоновом потоке: ход его не ждёт (см. :func:`_flush_in_background`).

langfuse/opentelemetry — soft-import: отсутствие пакетов/ключей просто отключает трассировку
(никогда не роняет ход). В отличие от TS (два бандла → singleton на ``globalThis``), здесь обычный
module-local singleton — Python импортирует модуль единожды.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
from contextlib import ExitStack
from dataclasses import dataclass
from typing import Any

from ..als import HostLangfuseScope, current_scope
from ..types import Ai37Metadata
from .trace_v1 import TRACE_SCHEMA_VERSION, trace_metadata

logger = logging.getLogger(__name__)

_HEX32 = re.compile(r"^[0-9a-f]{32}$", re.IGNORECASE)

# undefined(=_UNSET) — ещё не инициализировали; None — инициализировали и трассировка выключена.
_UNSET = object()
_client: Any = _UNSET

# Фоновый flush после хода: не больше одного потока за раз (см. _flush_in_background).
_flush_lock = threading.Lock()
_flush_thread: threading.Thread | None = None


def _env_bool(value: str | None, default: bool) -> bool:
    if value is None or value == "":
        return default
    return value.lower() in ("true", "1", "yes", "on")


def is_langfuse_content_captured() -> bool:
    """Писать ли в трейс СОДЕРЖИМОЕ хода: текст пользователя, промпты, ответы модели, результат.

    По умолчанию НЕТ — паритет с ``isLangfuseContentCaptured`` ts-host. Хост общий, агенты на нём
    обрабатывают персональные данные третьих лиц, а трейс привязан к ``userId``/``sessionId`` и
    уезжает туда, где стоит Langfuse. Структура и тайминги — да, содержимое — нет. Включать
    осознанно: ``LANGFUSE_CAPTURE_CONTENT=true`` — только там, где Langfuse в своём контуре и у
    обработки содержимого есть правовое основание.
    """
    return _env_bool(os.environ.get("LANGFUSE_CAPTURE_CONTENT"), False)


def _is_own_trace_metadata(data: Any) -> bool:
    """Служебная метаданная хода (``trace_metadata``) — не содержимое: turnId, статус, канал,
    тенант.

    Маска SDK применяется и к metadata, поэтому её пропускаем по маркеру схемы — иначе трейс лишился
    бы всего, ради чего он нужен. Бывает и словарём, и уже сериализованной строкой.
    """
    if isinstance(data, str):
        markers = (
            f'"schemaVersion":"{TRACE_SCHEMA_VERSION}"',
            f'"schemaVersion": "{TRACE_SCHEMA_VERSION}"',
        )
        return any(marker in data for marker in markers)
    return isinstance(data, dict) and data.get("schemaVersion") == TRACE_SCHEMA_VERSION


def _redacted_marker(data: Any) -> Any:
    """Метка вместо содержимого: сам факт и объём сохраняем — они нужны для диагностики.

    Словарём: Python SDK сериализует результат маски сам, в атрибут спана уходит строка JSON.
    """
    if data is None:
        return None
    if isinstance(data, str):
        chars: int | None = len(data)
    else:
        try:
            chars = len(json.dumps(data, ensure_ascii=False, default=str))
        except Exception:  # noqa: BLE001 - объём лишь подсказка, без него метка всё равно ставится
            chars = None
    return {"redacted": True, **({"chars": chars} if chars is not None else {})}


def langfuse_content_mask(*, data: Any, **_kwargs: Any) -> Any:
    """Маска клиента Langfuse (``Langfuse(mask=...)``): применяется ко ВСЕМ наблюдениям перед
    экспортом, включая те, что строит ``langfuse.langchain.CallbackHandler`` (промпты и ответы
    модели) — их хост иначе не контролирует. Служебную метаданную пропускаем, остальное — метка.
    Паритет с ``langfuseContentMask`` ts-host.
    """
    return data if _is_own_trace_metadata(data) else _redacted_marker(data)


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
            # Без захвата содержимого — маска на всё, кроме служебной метаданной хода.
            mask=None if is_langfuse_content_captured() else langfuse_content_mask,
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


def _remote_parent_context(carrier: dict[str, str] | None) -> Any:
    """OTel-контекст со спаном оркестратора из входящего ``traceparent``; None, если его нет.

    Битый ``traceparent`` ``extract`` молча пропускает и оставляет активным текущий спан — такой
    контекст родителем не считаем.
    """
    if not carrier:
        return None
    from opentelemetry import propagate, trace

    ctx = propagate.extract(carrier)
    return ctx if trace.get_current_span(ctx).get_span_context().is_remote else None


def _root_context(trace_context: dict[str, str] | None) -> Any:
    """Контекст без активного спана, чтобы ход без родителя стал корнем своего трейса.

    Активным может оказаться чужой спан, которого нет в Langfuse: a2a-sdk при установленном
    OpenTelemetry сам открывает SERVER-спан на запрос (``trace_class`` у request handler'а), а
    фильтр экспорта Langfuse такие спаны отбрасывает. Под ним turn-спан получал
    ``parentObservationId``, которого нет ни в одном трейсе (prod Полиметрики, 29.10). С
    ``trace_context`` родителя задаёт сам Langfuse, здесь ничего не нужно.
    """
    if trace_context is not None:
        return None
    from opentelemetry import trace

    return trace.set_span_in_context(trace.INVALID_SPAN)


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

    remote_parent = _remote_parent_context(args.parent_carrier)
    trace_context = (
        None if remote_parent is not None else _trace_context_from_id(args.metadata.trace_id)
    )
    parent_ctx = remote_parent if remote_parent is not None else _root_context(trace_context)
    tags = [t for t in (args.metadata.channel, args.metadata.app_id) if t]

    token = otel_context.attach(parent_ctx) if parent_ctx is not None else None
    try:
        span_cm = (
            client.start_as_current_observation(name=args.agent_name, trace_context=trace_context)
            if trace_context
            else client.start_as_current_observation(name=args.agent_name)
        )
        # ExitStack держит propagate_attributes на весь ход и закрывает его раньше turn-спана.
        with span_cm as span, ExitStack() as turn_attributes:
            _apply_trace_attributes(turn_attributes, args, tags)
            handler = _make_callback_handler()
            trace_id = _current_trace_id(client)
            scope = current_scope()
            if scope is not None:
                scope.langfuse = HostLangfuseScope(trace_id=trace_id, span=span, handler=handler)
            try:
                result = await run()
            except Exception:
                _update_turn_status(span, args, "failed")
                raise
            out = to_output(result) if to_output is not None else None
            if isinstance(out, dict):
                span.update(output=out)
            status = out.get("status") if isinstance(out, dict) else None
            _update_turn_status(span, args, _normalize_status(status))
            return result
    finally:
        if token is not None:
            otel_context.detach(token)
        _flush_in_background(client)


def _flush_in_background(client: Any) -> None:
    """Дослать батч Langfuse после хода, не задерживая ход и event loop.

    ``Langfuse.flush()`` синхронный: OTel ``force_flush`` (до 30 с) и ``join()`` очередей без
    таймаута. Вызванный прямо в async-коде, он держал event loop, пока идёт экспорт, а при
    деградации Langfuse вставали все запросы процесса (AI-37/polimetrika-data-agent#8).
    ``asyncio.to_thread`` с таймаутом тоже не годится: ход всё равно ждал бы таймаут, а брошенные
    потоки копились бы в executor'е по умолчанию, через который asyncio резолвит DNS.

    Поэтому поток-демон без ожидания, и не больше одного за раз: идёт flush — новый не запускаем.
    Батч от этого не теряется: ``BatchSpanProcessor`` экспортирует по своему расписанию, а при
    выходе процесса клиент досылает остальное сам (atexit ``shutdown``). Ошибка flush ход не роняет.
    """
    global _flush_thread
    with _flush_lock:
        if _flush_thread is not None and _flush_thread.is_alive():
            return
        _flush_thread = threading.Thread(
            target=_flush_quietly, args=(client,), name="ai37-langfuse-flush", daemon=True
        )
        _flush_thread.start()


def _flush_quietly(client: Any) -> None:
    try:
        client.flush()
    except Exception as exc:  # noqa: BLE001 - экспорт трейса не должен ронять сервис
        logger.warning("[ai37-agent-host] Langfuse flush не удался: %s", exc)


def _apply_trace_attributes(stack: ExitStack, args: BeginTurnArgs, tags: list[str]) -> None:
    """session_id/user_id/metadata/tags → trace через propagate_attributes (если доступен).

    Передаём только заданные значения: на ``None`` в metadata langfuse пишет WARNING «Propagated
    attribute … is None» на каждое поле в каждом ходе (intent, channel, tenant…).
    """
    metadata = trace_metadata(
        "turn",
        service=args.metadata.app_id or "ai37-agent-host",
        turn_id=args.task_id,
        session_id=args.context_id,
        taskId=args.task_id,
        runId=args.task_id,
        status="working",
        intent=args.metadata.intent.skill if args.metadata.intent else None,
        # Честная метка режима: по умолчанию содержимое хода в трейс не пишется вовсе.
        payloadMode=(
            "inline"
            if args.text is None
            else "inline-truncated"
            if is_langfuse_content_captured()
            else "redacted"
        ),
        channel=args.metadata.channel,
        app_id=args.metadata.app_id,
        billing_org_id=args.billing_org_id,
        tenant=args.metadata.tenant,
        contextId=args.context_id,
    )
    user_id = getattr(args.claims, "sub", None) if args.claims is not None else None
    attributes: dict[str, Any] = {
        "session_id": args.context_id or None,
        "user_id": user_id or None,
        "metadata": {key: value for key, value in metadata.items() if value is not None},
        "tags": tags or None,
    }
    try:
        from langfuse import propagate_attributes

        stack.enter_context(
            propagate_attributes(**{k: v for k, v in attributes.items() if v is not None})
        )
    except Exception:  # noqa: BLE001 - атрибуты не критичны для хода
        pass


def _normalize_status(status: Any) -> str:
    if status == "input-required":
        return "input-required"
    if status in {"failed", "error"}:
        return "failed"
    return "completed"


def _update_turn_status(span: Any, args: BeginTurnArgs, status: str) -> None:
    try:
        span.update(
            metadata=trace_metadata(
                "turn",
                service=args.metadata.app_id or "ai37-agent-host",
                turn_id=args.task_id,
                session_id=args.context_id,
                taskId=args.task_id,
                runId=args.task_id,
                status=status,
                intent=args.metadata.intent.skill if args.metadata.intent else None,
                channel=args.metadata.channel,
                app_id=args.metadata.app_id,
                billing_org_id=args.billing_org_id,
                tenant=args.metadata.tenant,
                contextId=args.context_id,
            )
        )
    except Exception:
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
            active_trace_id = _current_trace_id(client) or agent_id
            span.update(
                metadata=trace_metadata(
                    "agent",
                    service="ai37-agent-host",
                    turn_id=active_trace_id,
                    session_id=active_trace_id,
                    agentId=agent_id,
                    kind="remote-a2a",
                )
            )
        except Exception:  # noqa: BLE001
            pass
        return await run()
