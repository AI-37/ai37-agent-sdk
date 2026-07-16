"""Контракт текста ответа суб-агента (``extract_text``): авторитет — ``status.message``;
text-артефакты при стриминге содержат ТОТ ЖЕ ответ (живая проекция), поэтому суммировать их с ним
нельзя — иначе агент на штатном A2A-стриминге отдаёт пользователю ответ дважды. Порт тестов ts-host
``relay.test.ts``.
"""

from typing import Any

from ai37_agent_host.relay import extract_text


def _streamed_task(status_message_text: str | None) -> dict[str, Any]:
    status: dict[str, Any] = {"state": "TASK_STATE_COMPLETED"}
    if status_message_text is not None:
        status["message"] = {
            "role": "ROLE_AGENT",
            "parts": [{"text": status_message_text, "mediaType": "text/plain"}],
        }
    return {
        "id": "t",
        "contextId": "c",
        "status": status,
        # Артефакт-стрим: тот же ответ, накопленный дельтами.
        "artifacts": [
            {
                "artifactId": "response-text",
                "parts": [{"text": "ответ агента", "mediaType": "text/plain"}],
            }
        ],
    }


def test_streaming_agent_status_and_same_artifact_text_one_copy():
    # status.message + тот же текст в артефакте → ОДНА копия.
    assert extract_text(_streamed_task("ответ агента")) == "ответ агента"


def test_status_message_wins_over_artifact():
    # status.message авторитетнее артефакта (стрим мог разойтись со снапшотом).
    assert extract_text(_streamed_task("итоговый ответ")) == "итоговый ответ"


def test_falls_back_to_artifacts_when_no_terminal_text():
    # Нет терминального текста (агент отдал только стрим) → берём артефакты.
    assert extract_text(_streamed_task(None)) == "ответ агента"


def test_create_agent_host_data_only_artifacts_one_copy():
    # Агент на create_agent_host: текст в status.message, артефакты только data → ОДНА копия.
    host_style_task = {
        "id": "t",
        "contextId": "c",
        "status": {
            "state": "TASK_STATE_COMPLETED",
            "message": {
                "role": "ROLE_AGENT",
                "parts": [{"text": "расчёт готов", "mediaType": "text/plain"}],
            },
        },
        "artifacts": [
            {
                "artifactId": "result",
                "parts": [
                    {"data": {"a2ui": [], "result": {"x": 1}}, "mediaType": "application/json"}
                ],
            }
        ],
    }
    assert extract_text(host_style_task) == "расчёт готов"
