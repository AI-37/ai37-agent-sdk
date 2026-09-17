"""One execution's ordered native A2A progress and append-only answer artifact."""

from __future__ import annotations

import asyncio

from a2a.server.tasks import TaskUpdater
from a2a.types import TaskState

from .build_task import text_part
from .types import AgentEvent, NodeEvent, ReasoningEvent, TextEvent


class A2aProgress:
    """Bridge synchronous ``emit`` to async publication without buffering the answer."""

    def __init__(self, updater: TaskUpdater, task_id: str) -> None:
        self._updater = updater
        self._artifact_id = f"answer-{task_id}"
        self._queue: asyncio.Queue[NodeEvent | ReasoningEvent | TextEvent | None] = asyncio.Queue()
        self._working = False
        self._text_started = False
        self._drain_task = asyncio.create_task(self._drain())

    def emit(self, event: AgentEvent) -> None:
        if not isinstance(event, NodeEvent | ReasoningEvent | TextEvent):
            return
        if isinstance(event, TextEvent) and not event.delta:
            return
        self._queue.put_nowait(event)

    async def finish(self) -> None:
        self._queue.put_nowait(None)
        await self._drain_task

    async def _drain(self) -> None:
        while (event := await self._queue.get()) is not None:
            await self._publish(event)
        if self._text_started:
            await self._publish_text("", append=True, last_chunk=True)

    async def _publish(self, event: NodeEvent | ReasoningEvent | TextEvent) -> None:
        if not self._working:
            self._working = True
            await self._updater.start_work()
        if isinstance(event, TextEvent):
            if not self._text_started:
                self._text_started = True
                await self._publish_text("", append=False, last_chunk=False)
            await self._publish_text(event.delta, append=True, last_chunk=False)
            return
        metadata = (
            {"ai37/node": event.node}
            if isinstance(event, NodeEvent)
            else {"ai37/reasoning": event.delta}
        )
        await self._updater.update_status(TaskState.TASK_STATE_WORKING, metadata=metadata)

    async def _publish_text(self, text: str, *, append: bool, last_chunk: bool) -> None:
        await self._updater.add_artifact(
            parts=[text_part(text)] if text else [],
            artifact_id=self._artifact_id,
            name="answer",
            append=append,
            last_chunk=last_chunk,
        )
