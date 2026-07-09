"""relay — переносимая A2A-relay-механика (orchestrator-side: вызов другого агента + HITL-канал).

Порт ``ts-host/src/relay``. Транспорт-агностично: политику («кого звать») и durable-стор держит
потребитель. Модули: ``task_store`` (маппинг resume childTaskId), ``extract`` (разбор ответа
суб-агента), ``execute`` (вызов через ``a2a-sdk`` Client) — портируются по мере надобности
оркестратора; сам Minstroy (вызываемый агент) relay не использует.
"""

from __future__ import annotations

from .task_store import InMemoryRemoteTaskStore, RemoteTaskRef, RemoteTaskStore

__all__ = [
    "RemoteTaskStore",
    "RemoteTaskRef",
    "InMemoryRemoteTaskStore",
]
