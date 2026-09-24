"""Persist-state многоходового диалога: читается ПОСЛЕДНЕЕ состояние, а не первое.

Прод 24.09.2026 (minstroy). `_read_prior_state` перебирал артефакты задачи сверху вниз и отдавал
первое найденное `state`. Список артефактов копится за диалог, поэтому агент на каждом ходе
получал состояние самого первого сообщения — `{"phase": "awaiting-signature"}` без `bulkTaskId`.
Защита от повторного запуска смотрела именно на `bulkTaskId`, не находила его и пропускала ход
дальше: по одному файлу поднялось два платных прогона и списалось два комплекта единиц.

Лечится с двух сторон, и обе проверяются здесь: читаем с конца (это чинит и задачи, которые уже
лежат в сторе с накопленными артефактами) и пишем под постоянным `artifact_id`, чтобы менеджер
задач артефакт заменял, а не копил.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from a2a.types import Message, a2a_pb2
from google.protobuf.json_format import MessageToDict, ParseDict

from ai37_agent_host.a2a_executor import HostExecutor, _read_prior_state
from ai37_agent_host.types import AgentRequest, AgentResult


def _task(*states: dict[str, Any], metadata: dict[str, Any] | None = None) -> Any:
    """Задача с артефактом на каждое состояние — в том порядке, в каком их писали ходы."""
    payload: dict[str, Any] = {
        "id": "t1",
        "contextId": "c1",
        "artifacts": [
            {
                "artifactId": f"a{index}",
                "name": "input-required",
                "parts": [{"data": {"state": state}, "mediaType": "application/json"}],
            }
            for index, state in enumerate(states)
        ],
    }
    if metadata is not None:
        payload["metadata"] = metadata
    return ParseDict(payload, a2a_pb2.Task(), ignore_unknown_fields=True)


def _context(task: Any) -> Any:
    return SimpleNamespace(current_task=task)


class TestReadPriorState:
    def test_no_task_means_no_state(self) -> None:
        assert _read_prior_state(_context(None)) is None

    def test_single_artifact_is_returned(self) -> None:
        assert _read_prior_state(_context(_task({"phase": "processing"}))) == {
            "phase": "processing"
        }

    def test_latest_artifact_wins(self) -> None:
        """Тот самый дефект: раньше возвращался первый, то есть состояние начала диалога."""
        task = _task(
            {"kind": "price", "phase": "awaiting-signature"},
            {"kind": "price", "phase": "processing", "bulkTaskId": "7f05f7a0"},
            {"kind": "price", "phase": "processing", "bulkTaskId": "d3531b2c"},
        )

        state = _read_prior_state(_context(task))

        assert state is not None
        assert state["bulkTaskId"] == "d3531b2c"

    def test_stale_first_artifact_does_not_hide_the_running_task(self) -> None:
        """Ход после запуска прогона обязан видеть его id — иначе заводится второй, платный."""
        task = _task(
            {"phase": "awaiting-signature"},
            {"phase": "processing", "bulkTaskId": "7f05f7a0"},
        )

        state = _read_prior_state(_context(task))

        assert state is not None
        assert "bulkTaskId" in state

    def test_artifacts_without_state_are_skipped(self) -> None:
        task = _task({"phase": "processing"})
        as_dict = MessageToDict(task, preserving_proto_field_name=False)
        as_dict["artifacts"].append(
            {"artifactId": "later", "name": "result", "parts": [{"data": {"result": {"ok": True}}}]}
        )
        rebuilt = ParseDict(as_dict, a2a_pb2.Task(), ignore_unknown_fields=True)

        assert _read_prior_state(_context(rebuilt)) == {"phase": "processing"}

    def test_metadata_is_the_fallback(self) -> None:
        """Запасной путь (как у TS-хоста) остаётся: артефактов нет — смотрим metadata."""
        task = ParseDict(
            {"id": "t1", "contextId": "c1", "metadata": {"state": {"phase": "processing"}}},
            a2a_pb2.Task(),
            ignore_unknown_fields=True,
        )

        assert _read_prior_state(_context(task)) == {"phase": "processing"}

    def test_artifacts_win_over_metadata(self) -> None:
        task = _task({"phase": "processing"}, metadata={"state": {"phase": "stale"}})

        assert _read_prior_state(_context(task)) == {"phase": "processing"}


class _AsksAgain:
    def __init__(self, status: str) -> None:
        self.status = status

    async def run(self, _req: AgentRequest) -> AgentResult:
        return AgentResult(status=self.status, message="ещё разок", state={"phase": "processing"})


async def _artifacts(status: str) -> list[dict[str, Any]]:
    queue_events: list[Any] = []

    class Queue:
        async def enqueue_event(self, event: Any) -> None:
            queue_events.append(event)

    executor = HostExecutor(_AsksAgain(status), agent_text_modes=["text/plain"])
    rc = SimpleNamespace(
        message=ParseDict(
            {"role": "ROLE_USER", "parts": [{"text": "hi"}]}, Message(), ignore_unknown_fields=True
        ),
        task_id="t1",
        context_id="c1",
        configuration=None,
        current_task=None,
    )
    await executor.execute(rc, Queue())
    out = []
    for event in queue_events:
        data = MessageToDict(event, preserving_proto_field_name=False)
        if "artifact" in data:
            out.append(data["artifact"])
    return out


class TestArtifactIdIsPinned:
    """Без постоянного id `add_artifact` сочиняет UUID и артефакты копятся весь диалог."""

    async def test_input_required_keeps_one_slot(self) -> None:
        artifacts = await _artifacts("input-required")
        assert [a.get("artifactId") for a in artifacts] == ["input-required"]

    async def test_working_keeps_one_slot(self) -> None:
        artifacts = await _artifacts("working")
        assert [a.get("artifactId") for a in artifacts] == ["working"]
