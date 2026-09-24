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


class _Answers:
    """Агент, который на каждом ходе возвращает своё состояние — как HITL-диалог."""

    def __init__(self, status: str, states: list[dict[str, Any]]) -> None:
        self.status = status
        self.states = list(states)
        self.seen: list[dict[str, Any] | None] = []

    async def run(self, req: AgentRequest) -> AgentResult:
        self.seen.append(req.input.task_state)
        return AgentResult(status=self.status, message="ещё разок", state=self.states.pop(0))


async def _turn(handler: Any, current_task: Any) -> list[dict[str, Any]]:
    """Один ход через executor; возвращает артефакты, которые он опубликовал."""
    events: list[Any] = []

    class Queue:
        async def enqueue_event(self, event: Any) -> None:
            events.append(event)

    executor = HostExecutor(handler, agent_text_modes=["text/plain"])
    rc = SimpleNamespace(
        message=ParseDict(
            {"role": "ROLE_USER", "parts": [{"text": "hi"}]}, Message(), ignore_unknown_fields=True
        ),
        task_id="t1",
        context_id="c1",
        configuration=None,
        current_task=current_task,
    )
    await executor.execute(rc, Queue())
    out = []
    for event in events:
        data = MessageToDict(event, preserving_proto_field_name=False)
        if "artifact" in data:
            out.append(data["artifact"])
    return out


def _apply(task: Any, artifacts: list[dict[str, Any]]) -> Any:
    """Сложить артефакты хода в задачу ровно так, как это делает менеджер задач a2a-sdk.

    Совпал `artifactId` — запись заменяется НА МЕСТЕ, по старому индексу (`task_manager.py`,
    `CopyFrom`); не совпал — дописывается в хвост. Модель здесь честная нарочно: на ней держится
    проверка того, что позиция в списке означает свежесть.
    """
    as_dict = (
        MessageToDict(task, preserving_proto_field_name=False)
        if task is not None
        else {"id": "t1", "contextId": "c1"}
    )
    existing = as_dict.setdefault("artifacts", [])
    for artifact in artifacts:
        same_id = artifact.get("artifactId")
        at = next((i for i, old in enumerate(existing) if old.get("artifactId") == same_id), None)
        if at is None:
            existing.append(artifact)
        else:
            existing[at] = artifact
    return ParseDict(as_dict, a2a_pb2.Task(), ignore_unknown_fields=True)


class TestStateSurvivesADialogue:
    """Настоящий контракт фикса: агент на КАЖДОМ ходе видит то, что записал на предыдущем."""

    async def test_second_turn_sees_what_the_first_turn_saved(self) -> None:
        handler = _Answers(
            "input-required",
            [
                {"phase": "awaiting-signature"},
                {"phase": "processing", "bulkTaskId": "7f05f7a0"},
            ],
        )

        task = _apply(None, await _turn(handler, None))
        await _turn(handler, task)

        assert handler.seen[0] is None, "на первом ходе состояния ещё нет"
        assert handler.seen[1] == {"phase": "awaiting-signature"}

    async def test_third_turn_sees_the_second_not_the_first(self) -> None:
        """Тот самый инцидент: ход после запуска прогона обязан видеть его id, а не начало
        диалога."""
        handler = _Answers(
            "input-required",
            [
                {"phase": "awaiting-signature"},
                {"phase": "processing", "bulkTaskId": "7f05f7a0"},
                {"phase": "processing", "bulkTaskId": "7f05f7a0"},
            ],
        )

        task = _apply(None, await _turn(handler, None))
        task = _apply(task, await _turn(handler, task))
        await _turn(handler, task)

        assert handler.seen[2] is not None
        assert handler.seen[2]["bulkTaskId"] == "7f05f7a0", (
            "третий ход не увидел запущенный прогон — завёлся бы второй, платный"
        )

    async def test_position_tracks_recency(self) -> None:
        """Инвариант, на котором держится чтение с конца: артефакты состояния ДОПИСЫВАЮТСЯ.

        Закрепи им `artifact_id` — менеджер задач стал бы заменять их на месте, свежее состояние
        осталось бы в начале списка, и чтение с конца вернуло бы устаревшее.
        """
        handler = _Answers("input-required", [{"n": 1}, {"n": 2}])

        first = await _turn(handler, None)
        task = _apply(None, first)
        second = await _turn(handler, task)

        assert len(first) == 1 and len(second) == 1
        assert first[0]["parts"][0]["data"]["state"] == {"n": 1}
        assert second[0]["parts"][0]["data"]["state"] == {"n": 2}
        assert first[0].get("artifactId") != second[0].get("artifactId"), (
            "артефакты состояния делят id — значит заменяются на месте, и порядок лжёт о свежести"
        )

    async def test_working_between_two_questions_does_not_shadow_the_fresh_state(self) -> None:
        """Порядок, который ловит закреплённый `artifact_id`: спросили → поработали → спросили.

        С закреплёнными id третий ход заменил бы артефакт `input-required` на его СТАРОМ месте,
        перед `working`, и чтение с конца вернуло бы состояние второго хода вместо третьего.
        """
        task = _apply(None, await _turn(_Answers("input-required", [{"phase": "first"}]), None))
        task = _apply(task, await _turn(_Answers("working", [{"phase": "detached"}]), task))
        task = _apply(task, await _turn(_Answers("input-required", [{"phase": "fresh"}]), task))

        later = _Answers("input-required", [{"phase": "whatever"}])
        await _turn(later, task)

        assert later.seen[0] == {"phase": "fresh"}, (
            "ход увидел состояние ПРОШЛОГО хода — артефакты состояния заменяются на месте, "
            "и порядок в списке больше не означает свежесть"
        )
