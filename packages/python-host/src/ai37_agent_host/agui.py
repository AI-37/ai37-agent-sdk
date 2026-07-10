"""AG-UI SSE-адаптер (канон) — порт ``ts-host/src/agui.ts`` на FastAPI/Starlette.

Эмитит каноничные AG-UI-события через ``ag_ui.encoder.EventEncoder`` (SSE), совместимые с
``@ag-ui/client`` HttpAgent (CopilotKit v2): RUN_STARTED → TEXT_MESSAGE_* → ACTIVITY_SNAPSHOT
(``a2ui-surface`` с ``content.a2ui_operations`` v0.9) → RUN_FINISHED/RUN_ERROR.

Готовый A2UI (``AgentResult.a2ui`` / ``emit(A2uiEvent)``) отдаётся как activity-сообщение
``a2ui-surface`` — рендерится CopilotKit нативно через ai37Catalog. Tool-call ``render_a2ui`` НЕ
используем (он в CopilotKit для LLM-генерации UI).

Отличия от TS (async/sync-природа + soft-import):
  * ``ag_ui`` (протокол/энкодер) — soft-import: пакет опционален (optional-группа ``agui``).
    Отсутствие пакета НЕ роняет импорт модуля; фабрика :func:`agui_routes` при вызове бросает
    понятную ошибку. Точно как ``observability/langfuse.py`` мягко импортирует langfuse.
  * Sync-``emit`` домена → async-публикация SSE: мост через ``asyncio.Queue`` + async-drain внутри
    генератора ``EventSourceResponse`` (тот же паттерн sync-emit→queue→async-drain, что в
    ``a2a_executor.py``); порядок событий сохраняется.
  * ``taskStore`` (a2a-sdk 1.x) работает с protobuf-``Task`` и требует ``ServerCallContext``,
    а ``load``/``save`` из TS отсутствуют — persist-state читаем/пишем через ``get``/``save``
    best-effort в data-part артефакта ``{state}`` (тот же формат, что ``a2a_executor._finalize``).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

from .a2ui import component_to_a2ui_operations
from .als import current_ctx, current_scope
from .observability.langfuse import BeginTurnArgs, with_turn_observability
from .output_modes import negotiate_output, read_client_capabilities
from .types import (
    A2uiAction,
    A2uiComponent,
    AgentEvent,
    AgentHandler,
    AgentInput,
    AgentRequest,
    AgentResult,
    Ai37Metadata,
)

# ── soft-import ag_ui (optional-группа ``agui``) ──────────────────────────────
# Отсутствие пакета НЕ роняет импорт модуля — фабрика ниже бросает понятную ошибку при вызове.
try:  # pragma: no cover - зависит от наличия optional-группы agui
    from ag_ui.core import (
        ActivitySnapshotEvent,
        EventType,
        ReasoningEndEvent,
        ReasoningMessageContentEvent,
        ReasoningMessageEndEvent,
        ReasoningMessageStartEvent,
        ReasoningStartEvent,
        RunErrorEvent,
        RunFinishedEvent,
        RunStartedEvent,
        TextMessageContentEvent,
        TextMessageEndEvent,
        TextMessageStartEvent,
        ToolCallArgsEvent,
        ToolCallEndEvent,
        ToolCallResultEvent,
        ToolCallStartEvent,
    )
    from ag_ui.encoder import EventEncoder

    _AGUI_IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 - модуль должен грузиться без optional-пакета
    _AGUI_IMPORT_ERROR = exc


_AGUI_MISSING_MSG = (
    "AG-UI SSE-адаптер требует пакет `ag-ui` (optional-группа `agui`). "
    "Установите его: `poetry install --with agui` (или добавьте `ag-ui` в зависимости)."
)


def _require_agui() -> None:
    """Бросить понятную ошибку, если optional-группа ``agui`` не установлена."""
    if _AGUI_IMPORT_ERROR is not None:
        raise RuntimeError(_AGUI_MISSING_MSG) from _AGUI_IMPORT_ERROR


# ── Чистые хелперы разбора AG-UI-тела (RunAgentInput-подобный dict) ───────────


def read_a2ui_action(forwarded_props: dict[str, Any] | None) -> A2uiAction | None:
    """A2UI-действие из ``forwardedProps.a2uiAction.userAction`` (канон ACTIVITY_SNAPSHOT).

    Юзер нажал кнопку/submit → ``{name, context, surfaceId?, sourceComponentId?}``. ``None``, если
    действия нет (обычный текстовый ход) или ``name`` не строка.
    """
    if not isinstance(forwarded_props, dict):
        return None
    action = forwarded_props.get("a2uiAction")
    ua = action.get("userAction") if isinstance(action, dict) else None
    if not isinstance(ua, dict) or not isinstance(ua.get("name"), str):
        return None
    ctx = ua.get("context")
    result = A2uiAction(
        name=ua["name"],
        context=ctx if isinstance(ctx, dict) else {},
    )
    if isinstance(ua.get("surfaceId"), str):
        result.surface_id = ua["surfaceId"]
    if isinstance(ua.get("sourceComponentId"), str):
        result.source_component_id = ua["sourceComponentId"]
    return result


def last_user_text(messages: Any) -> str | None:
    """Текст последнего сообщения пользователя (content = str | ``[{type:'text', text}]``)."""
    if not isinstance(messages, list):
        return None
    for m in reversed(messages):
        if not isinstance(m, dict) or m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            parts: list[str] = []
            for p in c:
                if isinstance(p, dict) and "text" in p:
                    parts.append(str(p["text"]))
            return "".join(parts)
    return None


def extract_ai37(body: dict[str, Any]) -> Ai37Metadata:
    """Собрать ``metadata.ai37`` из ``forwardedProps`` (канон AG-UI).

    Порт TS ``extractAi37``: разворачивает ``forwardedProps.ai37`` в :class:`Ai37Metadata`
    (только известные поля) и добивает ``thread_id`` из ``forwardedProps.thread_id`` / ``threadId``.
    ``acceptedOutputModes`` — единственный носитель формата текста для AG-UI (A2A-поля нет).
    """
    fp = body.get("forwardedProps") if isinstance(body.get("forwardedProps"), dict) else {}
    raw = fp.get("ai37") if isinstance(fp.get("ai37"), dict) else {}

    def _get(*keys: str) -> Any:
        for k in keys:
            v = raw.get(k)
            if v is not None:
                return v
        return None

    meta = Ai37Metadata(
        tenant=_get("tenant"),
        app_id=_get("app_id", "appId"),
        channel=_get("channel"),
        thread_id=_get("thread_id", "threadId"),
        session_id=_get("session_id", "sessionId"),
        trace_id=_get("trace_id", "traceId"),
        accepted_output_modes=raw.get("acceptedOutputModes"),
    )
    if not meta.thread_id:
        if isinstance(fp.get("thread_id"), str):
            meta.thread_id = fp["thread_id"]
        elif isinstance(body.get("threadId"), str):
            meta.thread_id = body["threadId"]
    return meta


def build_agent_input(
    body: dict[str, Any],
    *,
    negotiation: Any,
    metadata: Ai37Metadata,
    thread_id: str,
    accepted_output_modes: list[str] | None,
    supported_catalog_ids: list[str],
    prior_state: dict[str, Any] | None,
    claims: Any = None,
    billing_org_id: str | None = None,
) -> AgentInput:
    """Нормализованный :class:`AgentInput` из AG-UI-тела (порт сборки ``input`` в TS)."""
    fp = body.get("forwardedProps") if isinstance(body.get("forwardedProps"), dict) else {}
    data = fp.get("data") if isinstance(fp.get("data"), dict) else {}
    action = read_a2ui_action(fp)
    return AgentInput(
        data=data,
        metadata=metadata,
        task_id=thread_id,
        context_id=thread_id,
        negotiation=negotiation,
        text=last_user_text(body.get("messages")),
        action=action,
        claims=claims,
        billing_org_id=billing_org_id,
        accepted_output_modes=accepted_output_modes,
        supported_catalog_ids=supported_catalog_ids or None,
        task_state=prior_state,
    )


# ── persist-state через taskStore (best-effort, формат A2A-пути) ──────────────


def _read_prior_state_from_task(task: Any) -> dict[str, Any] | None:
    """Persist-state прошлого хода: из data-part артефакта Task (формат ``a2a_executor``)."""
    if task is None:
        return None
    try:
        from google.protobuf.json_format import MessageToDict

        data = MessageToDict(task, preserving_proto_field_name=False)
    except Exception:  # noqa: BLE001 - task может быть не-protobuf/уже dict
        data = task if isinstance(task, dict) else {}
    for artifact in data.get("artifacts", []) or []:
        for part in artifact.get("parts", []) or []:
            payload = part.get("data")
            if isinstance(payload, dict) and isinstance(payload.get("state"), dict):
                return payload["state"]
    metadata = data.get("metadata")
    if isinstance(metadata, dict) and isinstance(metadata.get("state"), dict):
        return metadata["state"]
    return None


async def _load_prior_state(task_store: Any, thread_id: str) -> dict[str, Any] | None:
    """priorState для мультитёрна/HITL из task-store (taskId=threadId). None → первый ход.

    a2a-sdk 1.x: ``get(task_id, context)`` (protobuf-``Task``). ``load``/``save`` из TS нет.
    """
    if task_store is None:
        return None
    try:
        task = await task_store.get(thread_id, _call_context())
    except Exception:  # noqa: BLE001 - отсутствие/ошибка стора не роняет ход
        return None
    return _read_prior_state_from_task(task)


async def _save_state(
    task_store: Any,
    result: AgentResult,
    negotiation: Any,
    thread_id: str,
) -> None:
    """Персист состояния хода в task-store (формат data-part ``{state}`` как ``a2a_executor``).

    Тот же ``taskId``(=threadId), что на A2A-пути → state переживает ходы. В TS это ``toTask`` +
    ``taskStore.save``; ``toTask`` в python-host нет → собираем минимальный protobuf-``Task`` из
    существующих хелперов best-effort. Ошибки/отсутствие стора — no-op (не роняем ход).
    """
    if task_store is None or result.state is None:
        return
    try:
        from a2a.types import Artifact, Task

        from .build_task import data_part

        artifact = Artifact(artifact_id="result", parts=[data_part({"state": result.state})])
        task = Task(id=thread_id, context_id=thread_id, artifacts=[artifact])
        await task_store.save(task, _call_context())
    except Exception:  # noqa: BLE001 - persist не должен ронять ход
        pass


def _call_context() -> Any:
    """``ServerCallContext`` для taskStore (a2a-sdk 1.x требует его в ``get``/``save``)."""
    try:
        from a2a.server.context import ServerCallContext

        return ServerCallContext()
    except Exception:  # noqa: BLE001
        return None


# ── SSE-эмиттер одного хода ───────────────────────────────────────────────────


class _Emitter:
    """Собирает AG-UI-события хода в очередь; ленивое открытие text/reasoning-блоков (порт TS).

    Sync-методы (``emit_*``) зовутся из sync-``emit`` домена; события кладутся в ``asyncio.Queue``,
    async-drain в :func:`_run_turn` кодирует и пишет их в SSE-поток.
    """

    def __init__(self, queue: Any, negotiation: Any) -> None:
        self._queue = queue
        self._negotiation = negotiation
        self._text_message_id: str | None = None
        self._reasoning_block_id: str | None = None
        self._reasoning_message_id: str | None = None

    @property
    def text_message_id(self) -> str | None:
        return self._text_message_id

    def _put(self, event: Any) -> None:
        self._queue.put_nowait(event)

    # -- A2UI activity ``a2ui-surface`` --
    def emit_a2ui(self, component: A2uiComponent) -> None:
        """Готовый A2UI → activity ``a2ui-surface``. Эмитим ТОЛЬКО если каталог согласован.

        Каталог surface — тег компонента (``catalog_id``) либо первичный согласованный; если он не
        в согласованном множестве (``negotiation.catalog_ids``) — no-op (агент даёт другой вывод).
        """
        catalog_id = component.catalog_id or self._negotiation.catalog_id
        if not catalog_id or catalog_id not in self._negotiation.catalog_ids:
            return
        surface_id = f"surf-{uuid.uuid4()}"
        self._put(
            ActivitySnapshotEvent(
                type=EventType.ACTIVITY_SNAPSHOT,
                message_id=str(uuid.uuid4()),
                activity_type="a2ui-surface",
                content={
                    "a2ui_operations": component_to_a2ui_operations(
                        component, surface_id=surface_id, catalog_id=catalog_id
                    )
                },
                replace=True,
            )
        )

    # -- text --
    def ensure_text_start(self) -> str:
        if self._text_message_id is None:
            self._text_message_id = str(uuid.uuid4())
            self._put(
                TextMessageStartEvent(
                    type=EventType.TEXT_MESSAGE_START,
                    message_id=self._text_message_id,
                    role="assistant",
                )
            )
        return self._text_message_id

    def emit_text(self, delta: str) -> None:
        # НЕ закрываем reasoning здесь: агенты (напр. rag-factory за sub-agent-релеем) могут
        # перемежать reasoning/node с текстом в рамках ОДНОГО хода. Эагерное закрытие на первом
        # text-тике заставляло ensure_reasoning_start() открыть ВТОРОЙ REASONING-блок при возврате
        # reasoning — вторая «Thinking…»-карточка на один логический ход. Единственное закрытие —
        # end_reasoning() при завершении run()/ошибке. На видимость не влияет: CopilotChatReasoning-
        # Message сворачивает карточку по isLatest, а не по факту REASONING_END.
        if not delta:
            return
        message_id = self.ensure_text_start()
        self._put(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT, message_id=message_id, delta=delta
            )
        )

    def end_text(self) -> None:
        if self._text_message_id is not None:
            self._put(
                TextMessageEndEvent(
                    type=EventType.TEXT_MESSAGE_END, message_id=self._text_message_id
                )
            )

    def emit_full_text(self, text: str) -> None:
        """Финальный текст, если он не стримился во время run (result.message)."""
        message_id = str(uuid.uuid4())
        self._put(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START, message_id=message_id, role="assistant"
            )
        )
        self._put(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT, message_id=message_id, delta=text
            )
        )
        self._put(TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id))

    # -- reasoning/COT → нативные REASONING_* (CopilotKit «Thinking…» → «Thought for Ns») --
    def ensure_reasoning_start(self) -> str:
        if self._reasoning_message_id is None:
            self._reasoning_block_id = str(uuid.uuid4())
            self._reasoning_message_id = str(uuid.uuid4())
            self._put(
                ReasoningStartEvent(
                    type=EventType.REASONING_START, message_id=self._reasoning_block_id
                )
            )
            self._put(
                ReasoningMessageStartEvent(
                    type=EventType.REASONING_MESSAGE_START,
                    message_id=self._reasoning_message_id,
                    role="reasoning",
                )
            )
        return self._reasoning_message_id

    def emit_reasoning(self, delta: str) -> None:
        if not delta:
            return
        message_id = self.ensure_reasoning_start()
        self._put(
            ReasoningMessageContentEvent(
                type=EventType.REASONING_MESSAGE_CONTENT, message_id=message_id, delta=delta
            )
        )

    def end_reasoning(self) -> None:
        """Закрыть открытый reasoning-блок (перед финальным текстом/финалом). Идемпотентно."""
        if self._reasoning_message_id is not None:
            self._put(
                ReasoningMessageEndEvent(
                    type=EventType.REASONING_MESSAGE_END, message_id=self._reasoning_message_id
                )
            )
            self._put(
                ReasoningEndEvent(
                    type=EventType.REASONING_END, message_id=self._reasoning_block_id
                )
            )
            self._reasoning_message_id = None
            self._reasoning_block_id = None

    # -- tool-call → нативные TOOL_CALL_* (DefaultToolCallRenderer) --
    def emit_tool(self, event: AgentEvent) -> None:
        tool_id = getattr(event, "id", None) or f"tc-{uuid.uuid4()}"
        if event.phase == "start":
            self._put(
                ToolCallStartEvent(
                    type=EventType.TOOL_CALL_START,
                    tool_call_id=tool_id,
                    tool_call_name=event.name,
                )
            )
            if event.args is not None:
                self._put(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=tool_id,
                        delta=json.dumps(event.args),
                    )
                )
        else:
            self._put(ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=tool_id))
            if event.result is not None:
                content = (
                    event.result
                    if isinstance(event.result, str)
                    else json.dumps(event.result)
                )
                self._put(
                    ToolCallResultEvent(
                        type=EventType.TOOL_CALL_RESULT,
                        message_id=str(uuid.uuid4()),
                        tool_call_id=tool_id,
                        content=content,
                        role="tool",
                    )
                )

    def dispatch(self, event: AgentEvent) -> None:
        """Sync-``emit`` домена → соответствующее AG-UI-событие (порт switch в ``handler.run``)."""
        kind = getattr(event, "type", None)
        if kind == "text":
            self.emit_text(event.delta)
        elif kind == "a2ui":
            self.emit_a2ui(event.component)
        elif kind == "reasoning":
            self.emit_reasoning(event.delta)
        elif kind == "node":
            # back-compat: имя ноды агента вливаем строкой в reasoning-карточку.
            self.emit_reasoning(f"▸ {event.node}\n")
        elif kind == "tool":
            self.emit_tool(event)


# ── ход: RUN_STARTED → cognition → финал ─────────────────────────────────────

_STOP = object()


async def _run_turn(
    handler: AgentHandler,
    body: dict[str, Any],
    agent_text_modes: list[str],
    agent_catalog_ids: str | list[str] | None,
    task_store: Any,
) -> AsyncIterator[str]:
    """Асинхронный генератор AG-UI SSE-кадров одного хода (для ``StreamingResponse``).

    Yield'ит закодированные SSE-строки: RUN_STARTED → (стрим через ``emit``) → финальные text/a2ui →
    RUN_FINISHED/RUN_ERROR. Sync-``emit`` домена мостится через ``asyncio.Queue`` + drain здесь.
    """
    encoder = EventEncoder()
    ctx = current_ctx()
    thread_id = body.get("threadId") or str(uuid.uuid4())
    run_id = body.get("runId") or str(uuid.uuid4())

    metadata = extract_ai37(body)
    # content-negotiation (две оси) для AG-UI (нативных A2A-полей нет):
    #  - формат текста — forwardedProps.ai37.acceptedOutputModes;
    #  - каталог — forwardedProps.a2uiClientCapabilities.v0.9.supportedCatalogIds.
    accepted = metadata.accepted_output_modes
    supported_catalog_ids = read_client_capabilities(body.get("forwardedProps"))
    negotiation = negotiate_output(
        accepted_output_modes=accepted,
        agent_text_modes=agent_text_modes,
        supported_catalog_ids=supported_catalog_ids,
        agent_catalog_ids=agent_catalog_ids,
    )
    # Симметрия с A2A-путём: кладём обе оси в ALS-scope (guard уже открыл его; для AG-UI-тела пуст).
    scope = current_scope()
    if scope is not None:
        scope.accepted_output_modes = accepted
        if supported_catalog_ids:
            scope.supported_catalog_ids = supported_catalog_ids

    prior_state = await _load_prior_state(task_store, thread_id)
    agent_input = build_agent_input(
        body,
        negotiation=negotiation,
        metadata=metadata,
        thread_id=thread_id,
        accepted_output_modes=accepted,
        supported_catalog_ids=supported_catalog_ids,
        prior_state=prior_state,
        claims=ctx.claims if ctx else None,
        billing_org_id=ctx.billing_org_id if ctx else None,
    )

    queue: asyncio.Queue[Any] = asyncio.Queue()
    emitter = _Emitter(queue, negotiation)

    async def run_cognition() -> AgentResult:
        def emit(event: AgentEvent) -> None:
            emitter.dispatch(event)

        return await handler.run(AgentRequest(input=agent_input, emit=emit, ctx=ctx))

    async def cognition_with_finalize() -> AgentResult:
        # Langfuse turn-спан `agui-turn` (sessionId=contextId=threadId), активный в OTel на время
        # когниции → LangChain-спаны нестятся под него, исходящие A2A-вызовы форвардят traceparent.
        result = await with_turn_observability(
            BeginTurnArgs(
                context_id=thread_id,
                task_id=thread_id,
                claims=ctx.claims if ctx else None,
                metadata=metadata,
                text=agent_input.text,
                billing_org_id=ctx.billing_org_id if ctx else None,
                agent_name="agui-turn",
            ),
            run_cognition,
            lambda r: {"status": r.status, "message": r.message},
        )
        # Закрываем reasoning-блок до финального текста/завершения хода (если ещё открыт).
        emitter.end_reasoning()

        # Персист состояния хода (multi-turn/HITL) — тот же taskId(=threadId), что на A2A-пути.
        await _save_state(task_store, result, negotiation, thread_id)

        if emitter.text_message_id is not None:
            emitter.end_text()
        elif result.message:
            emitter.emit_full_text(result.message)

        for component in result.a2ui or []:
            emitter.emit_a2ui(component)
        if result.followup is not None:
            emitter.emit_a2ui(result.followup)

        if result.status == "failed":
            queue.put_nowait(
                RunErrorEvent(type=EventType.RUN_ERROR, message=result.message or "failed")
            )
        else:
            queue.put_nowait(
                RunFinishedEvent(
                    type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=run_id
                )
            )
        return result

    async def driver() -> None:
        try:
            await cognition_with_finalize()
        except Exception as exc:  # noqa: BLE001 - ошибку хода сворачиваем в RUN_ERROR
            emitter.end_reasoning()
            queue.put_nowait(RunErrorEvent(type=EventType.RUN_ERROR, message=str(exc)))
        finally:
            queue.put_nowait(_STOP)

    # RUN_STARTED первым — до старта когниции.
    yield encoder.encode(
        RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=run_id)
    )

    task = asyncio.create_task(driver())
    try:
        while True:
            event = await queue.get()
            if event is _STOP:
                break
            yield encoder.encode(event)
    finally:
        await task


# ── фабрика Starlette-routes (монтируется в create_agent_host под /agui) ──────


def agui_routes(
    handler: AgentHandler,
    agent_text_modes: list[str] | None = None,
    agent_catalog_ids: str | list[str] | None = None,
    task_store: Any = None,
    *,
    path: str = "/agui",
) -> list[Any]:
    """Список Starlette-routes AG-UI SSE-адаптера (порт ``aguiRouter``); монтируется в host-app.

    ``POST <path>`` → SSE-поток AG-UI-событий одного хода. Бросает понятную ошибку, если
    optional-группа ``agui`` (пакет ``ag-ui``) не установлена (soft-import).

    Используем Starlette ``StreamingResponse`` (media_type ``text/event-stream``), а не
    ``sse-starlette``: ``EventEncoder.encode`` уже возвращает готовые SSE-кадры (``data: …\\n\\n``),
    так что двойная SSE-обёртка не нужна (официальный AG-UI FastAPI-паттерн).
    """
    _require_agui()

    from starlette.requests import Request
    from starlette.responses import StreamingResponse
    from starlette.routing import Route

    modes = list(agent_text_modes or [])

    async def _handle(request: Request) -> StreamingResponse:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 - пустое/битое тело → пустой ход
            body = {}
        if not isinstance(body, dict):
            body = {}
        generator = _run_turn(handler, body, modes, agent_catalog_ids, task_store)
        return StreamingResponse(
            generator,
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )

    return [Route(path, _handle, methods=["POST"])]
