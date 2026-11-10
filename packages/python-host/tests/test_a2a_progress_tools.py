"""Вызовы инструментов агента доходят до карточки шагов: ``ToolEvent`` → ``metadata['ai37/tool']``.

Relay (`relay/execute.py`) и chat-backend уже читают ``ai37/tool`` как завершённый вызов
(``RemoteA2aToolCall``: id, name, args, result). Хост до 0.1.0a35 такие события отбрасывал.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from ai37_agent_host.a2a_progress import A2aProgress
from ai37_agent_host.types import NodeEvent, ToolEvent


class _Updater:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    async def start_work(self) -> None:
        self.calls.append(("start_work", None))

    async def update_status(self, state: Any, metadata: Any = None, **_: Any) -> None:
        self.calls.append(("update_status", metadata))

    async def add_artifact(self, **kwargs: Any) -> None:
        self.calls.append(("add_artifact", kwargs.get("append")))


def _tools(updater: _Updater) -> list[dict[str, Any]]:
    return [meta["ai37/tool"] for kind, meta in updater.calls if meta and "ai37/tool" in meta]


async def test_start_and_end_become_one_finished_call_with_args_of_start():
    updater = _Updater()
    progress = A2aProgress(updater, "t")  # type: ignore[arg-type]
    progress.emit(
        ToolEvent(phase="start", name="Проверяю ряды счетов", args={"since": date(2025, 1, 1)})
    )
    progress.emit(NodeEvent(node="шаг"))
    progress.emit(ToolEvent(phase="end", name="Проверяю ряды счетов", result="12 из 12 месяцев"))
    await progress.finish()
    [call] = _tools(updater)
    assert call["name"] == "Проверяю ряды счетов"
    assert call["args"] == {"since": "2025-01-01"}  # Struct принимает только JSON
    assert call["result"] == "12 из 12 месяцев"
    assert isinstance(call["id"], str) and call["id"]
    assert updater.calls[0] == ("start_work", None)
    # Порядок событий сохраняется: шаг узла — раньше завершения инструмента.
    kinds = [next(iter(meta)) for kind, meta in updater.calls if kind == "update_status" and meta]
    assert kinds == ["ai37/node", "ai37/tool"]


async def test_calls_pair_by_id_and_end_alone_is_still_published():
    updater = _Updater()
    progress = A2aProgress(updater, "t")  # type: ignore[arg-type]
    progress.emit(ToolEvent(phase="start", name="docs_read", id="a", args={"page": 1}))
    progress.emit(ToolEvent(phase="start", name="docs_read", id="b", args={"page": 2}))
    progress.emit(ToolEvent(phase="end", name="docs_read", id="b"))
    progress.emit(ToolEvent(phase="end", name="docs_read", id="a"))
    progress.emit(ToolEvent(phase="end", name="без начала"))
    await progress.finish()
    calls = _tools(updater)
    assert [(c["id"], c.get("args")) for c in calls[:2]] == [("b", {"page": 2}), ("a", {"page": 1})]
    assert calls[2]["name"] == "без начала" and "args" not in calls[2] and "result" not in calls[2]


async def test_start_without_end_publishes_nothing():
    updater = _Updater()
    progress = A2aProgress(updater, "t")  # type: ignore[arg-type]
    progress.emit(ToolEvent(phase="start", name="docs_read"))
    await progress.finish()
    assert updater.calls == []
