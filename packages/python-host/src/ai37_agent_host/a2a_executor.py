"""A2A-адаптер host'а — порт ``ts-host/src/a2a-executor.ts`` на ``a2a-sdk`` 1.x.

``HostExecutor`` парсит A2A-сообщение → вызывает ``AgentHandler`` с verified ``AgentContext``
(из ALS) → финализирует таск через ``TaskUpdater``. Когниции не содержит.

Отличия от TS (обусловлены async/protobuf-природой a2a-sdk):
  * события агента ``emit`` — СИНХРОННЫЕ, а публикация в a2a-sdk — async: мост через
    ``asyncio.Queue`` (sync ``put_nowait``) + фоновый async-drain, порядок сохраняется;
  * финализация — через ``TaskUpdater`` (submit/start_work/add_artifact/complete/failed/
    requires_input), а не построением Task-dict;
  * ``node``/``reasoning`` → ``update_status(WORKING, metadata={'ai37/node'|'ai37/reasoning'})``
    (стрим-событие ``TaskStatusUpdateEvent``); persist-state — в data-part финального артефакта
    (``TaskStatus`` не имеет metadata; ``TaskUpdater`` не пишет ``Task.metadata``).
"""

from __future__ import annotations

import asyncio
from typing import Any

from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.tasks import TaskUpdater
from a2a.types import Task, TaskState, TaskStatus
from google.protobuf.json_format import MessageToDict

from .als import current_accepted_output_modes, current_ctx
from .build_task import data_part, resolve_result_a2ui, text_part
from .output_modes import negotiate_output
from .parse import parse_a2a_message
from .types import AgentEvent, AgentHandler, AgentInput, AgentRequest, AgentResult

_STOP = object()


class HostExecutor(AgentExecutor):
    """A2A-адаптер: сообщение → ``AgentHandler.run`` → таск через ``TaskUpdater``.

    ``agent_text_modes`` — текстовые форматы агента (agent-card ``defaultOutputModes``);
    ``agent_catalog_ids`` — каталог(и) A2UI агента. Для content-negotiation (РЕШЕНИЕ 10).
    """

    def __init__(
        self,
        handler: AgentHandler,
        agent_text_modes: list[str] | None = None,
        agent_catalog_ids: str | list[str] | None = None,
    ) -> None:
        self._handler = handler
        self._agent_text_modes = list(agent_text_modes or [])
        self._agent_catalog_ids = agent_catalog_ids

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        ctx = current_ctx()
        parsed = parse_a2a_message(context)
        accepted = _read_accepted_output_modes(context)
        supported = parsed.supported_catalog_ids or None
        negotiation = negotiate_output(
            accepted_output_modes=accepted,
            agent_text_modes=self._agent_text_modes,
            supported_catalog_ids=supported,
            agent_catalog_ids=self._agent_catalog_ids,
        )
        task_id = context.task_id
        context_id = context.context_id
        updater = TaskUpdater(event_queue, task_id, context_id)
        # Публикуем Task САМИМ Task-событием (а не через updater.submit() == update_status(SUBMITTED)
        # → TaskStatusUpdateEvent). Инвариант «Task заэнкьюен ДО любого TaskStatusUpdateEvent» держат
        # ДВА консьюмера: серверный (a2a-sdk ActiveTask._run_consumer — иначе InvalidAgentResponseError)
        # и КЛИЕНТСКИЙ (оркестратор drainStream'ит свежий sendMessageStream). На resume серверу Task не
        # нужен (setup уже поставил _task_created), НО клиентский стрим начинается заново и без Task-
        # события не соберёт финал («поток не дал финального Message/Task»). Поэтому публикуем всегда:
        # на первом ходу — submitted-снапшот, на resume — текущий снапшот задачи из store.
        current = getattr(context, "current_task", None)
        if current is None:
            initial = Task(
                id=task_id,
                context_id=context_id,
                status=TaskStatus(state=TaskState.TASK_STATE_SUBMITTED),
            )
            if context.message is not None:
                initial.history.append(context.message)
            await event_queue.enqueue_event(initial)
        else:
            await event_queue.enqueue_event(current)

        agent_input = AgentInput(
            data=parsed.data,
            metadata=parsed.metadata,
            task_id=task_id,
            context_id=context_id,
            negotiation=negotiation,
            text=parsed.text,
            action=parsed.action,
            claims=ctx.claims if ctx else None,
            billing_org_id=ctx.billing_org_id if ctx else None,
            accepted_output_modes=accepted,
            supported_catalog_ids=supported,
            task_state=_read_prior_state(context),
        )

        # sync emit → async TaskUpdater: очередь + фоновый drain (порядок сохраняется).
        queue: asyncio.Queue[Any] = asyncio.Queue()

        def emit(event: AgentEvent) -> None:
            if getattr(event, "type", None) in ("node", "reasoning"):
                queue.put_nowait(event)

        async def drain() -> None:
            started = False
            while True:
                event = await queue.get()
                if event is _STOP:
                    return
                if not started:
                    started = True
                    await updater.start_work()
                metadata = (
                    {"ai37/node": event.node}
                    if event.type == "node"
                    else {"ai37/reasoning": event.delta}
                )
                await updater.update_status(TaskState.TASK_STATE_WORKING, metadata=metadata)

        drain_task = asyncio.create_task(drain())
        try:
            result = await self._run_handler(agent_input, ctx, emit)
        finally:
            queue.put_nowait(_STOP)
            await drain_task

        await self._finalize(updater, result, negotiation)

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        # Host не знает про доменную отмену; агенты со специфической отменой переопределяют.
        return None

    async def _run_handler(
        self,
        agent_input: AgentInput,
        ctx: Any,
        emit: Any,
    ) -> AgentResult:
        try:
            return await self._handler.run(AgentRequest(input=agent_input, emit=emit, ctx=ctx))
        except Exception as exc:  # noqa: BLE001 - ошибку хода сворачиваем в failed, не пробрасываем
            return AgentResult(status="failed", message=f"INTERNAL: {exc}")

    async def _finalize(
        self,
        updater: TaskUpdater,
        result: AgentResult,
        negotiation: Any,
    ) -> None:
        a2ui, followup = resolve_result_a2ui(result, negotiation)

        if result.status == "failed":
            await updater.failed(message=self._agent_msg(updater, result.message or "Ошибка"))
            return

        if result.status == "input-required":
            payload: dict[str, Any] = {"a2ui": followup or a2ui}
            if result.state is not None:
                payload["state"] = result.state
            await updater.add_artifact(parts=[data_part(payload)], name="input-required")
            await updater.requires_input(
                message=self._agent_msg(updater, result.message or "Уточните")
            )
            return

        if result.status == "working":
            # Detached: НЕ финализируем — оставляем таск WORKING (durable в task-store).
            # state/result кладём в data-part артефакта, чтобы resume (Ф9) восстановил их
            # (см. _read_prior_state). Поток A2A завершается закрытием event-queue.
            working: dict[str, Any] = {"a2ui": a2ui, "result": result.result}
            if result.state is not None:
                working["state"] = result.state
            await updater.add_artifact(parts=[data_part(working)], name="working")
            await updater.update_status(
                TaskState.TASK_STATE_WORKING,
                message=self._agent_msg(updater, result.message) if result.message else None,
            )
            return

        # completed
        completed: dict[str, Any] = {"a2ui": a2ui, "result": result.result}
        if result.state is not None:
            completed["state"] = result.state
        await updater.add_artifact(
            parts=[data_part(completed)], artifact_id="result", name="result"
        )
        await updater.complete(
            message=self._agent_msg(updater, result.message) if result.message else None
        )

    @staticmethod
    def _agent_msg(updater: TaskUpdater, text: str) -> Any:
        return updater.new_agent_message(parts=[text_part(text)])


def _read_accepted_output_modes(context: RequestContext) -> list[str] | None:
    """Формат текста из нативного configuration.accepted_output_modes (fallback ALS)."""
    config = getattr(context, "configuration", None)
    if config is not None:
        try:
            data = MessageToDict(config, preserving_proto_field_name=False)
            modes = data.get("acceptedOutputModes")
            if isinstance(modes, list):
                return [m for m in modes if isinstance(m, str)]
        except Exception:  # noqa: BLE001 - defensive: конфиг может быть не-protobuf
            pass
    return current_accepted_output_modes()


def _read_prior_state(context: RequestContext) -> dict[str, Any] | None:
    """Persist-state прошлого хода: из data-part артефакта current_task."""
    task = getattr(context, "current_task", None)
    if task is None:
        return None
    try:
        data = MessageToDict(task, preserving_proto_field_name=False)
    except Exception:  # noqa: BLE001
        return None
    for artifact in data.get("artifacts", []) or []:
        for part in artifact.get("parts", []) or []:
            payload = part.get("data")
            if isinstance(payload, dict) and isinstance(payload.get("state"), dict):
                return payload["state"]
    metadata = data.get("metadata")
    if isinstance(metadata, dict) and isinstance(metadata.get("state"), dict):
        return metadata["state"]
    return None
