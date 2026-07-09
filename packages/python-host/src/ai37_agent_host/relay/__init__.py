"""relay — переносимая A2A-relay-механика (orchestrator-side: вызов другого агента + HITL-канал).

Порт ``ts-host/src/relay``. Транспорт-агностично: политику («кого звать») и durable-стор держит
потребитель. Модули: ``task_store`` (маппинг resume childTaskId), ``extract`` (разбор ответа
суб-агента), ``execute`` (вызов через ``a2a-sdk`` Client). Сам Minstroy (вызываемый агент) relay
не использует — это для сборки Python-оркестратора.
"""

from __future__ import annotations

from .execute import (
    RemoteA2aProgressEvent,
    RemoteA2aRequest,
    RemoteA2aResult,
    RemoteA2aState,
    execute_remote_a2a,
)
from .extract import extract_a2ui, extract_text, is_stale_task_error
from .task_store import InMemoryRemoteTaskStore, RemoteTaskRef, RemoteTaskStore

__all__ = [
    "RemoteTaskStore",
    "RemoteTaskRef",
    "InMemoryRemoteTaskStore",
    "extract_text",
    "extract_a2ui",
    "is_stale_task_error",
    "execute_remote_a2a",
    "RemoteA2aRequest",
    "RemoteA2aResult",
    "RemoteA2aState",
    "RemoteA2aProgressEvent",
]
