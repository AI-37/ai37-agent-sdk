"""RemoteTaskStore — порт ``ts-host/src/relay/task-store.ts``.

Маппинг ``(parentContextId, agentId) → childTaskId`` для resume HITL/wizard через relay:
оркестратор обязан звать суб-агента тем же ``taskId`` между ходами (тот держит состояние по
``taskId``). Host даёт интерфейс + in-memory дефолт; durable-реализацию (Redis/Postgres)
инжектит потребитель. Механика orchestrator-side (Minstroy — вызываемый агент — её не трогает).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass
class RemoteTaskRef:
    task_id: str
    #: Последний статус таска суб-агента (``input-required`` → можно возобновлять).
    state: str


class RemoteTaskStore(Protocol):
    async def get(self, parent_context_id: str, agent_id: str) -> RemoteTaskRef | None: ...

    async def set(
        self, parent_context_id: str, agent_id: str, task_id: str, state: str
    ) -> None: ...

    async def clear(self, parent_context_id: str, agent_id: str) -> None: ...


class InMemoryRemoteTaskStore:
    """Per-process дефолт (не переживает рестарт/реплики). Для durable — своя реализация."""

    def __init__(self) -> None:
        self._map: dict[str, RemoteTaskRef] = {}

    @staticmethod
    def _key(parent_context_id: str, agent_id: str) -> str:
        return f"{parent_context_id} {agent_id}"

    async def get(self, parent_context_id: str, agent_id: str) -> RemoteTaskRef | None:
        return self._map.get(self._key(parent_context_id, agent_id))

    async def set(
        self, parent_context_id: str, agent_id: str, task_id: str, state: str
    ) -> None:
        self._map[self._key(parent_context_id, agent_id)] = RemoteTaskRef(
            task_id=task_id, state=state
        )

    async def clear(self, parent_context_id: str, agent_id: str) -> None:
        self._map.pop(self._key(parent_context_id, agent_id), None)
