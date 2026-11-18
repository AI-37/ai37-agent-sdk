"""Тексты, которые хост пишет пользователю сам, когда агент своего текста не дал.

Язык — локаль хода (:func:`current_locale`): без локали в конверте и токене это русский, как было.
Русский — источник истины. Паритет с ``@ai37/agent-host`` (``src/host-messages.ts``).
"""

from __future__ import annotations

from typing import Literal

from ai37_agent_sdk import t

from .als import current_locale

HostMessageKey = Literal["failed", "input_required", "tool_failed", "done"]

HOST_MESSAGES: dict[HostMessageKey, dict[str, str]] = {
    "failed": {
        "ru": "Ошибка",
        "en": "Error",
        "es": "Error",
        "de": "Fehler",
        "fr": "Erreur",
        "pt": "Erro",
    },
    "input_required": {
        "ru": "Уточните",
        "en": "Please clarify",
        "es": "Precisa tu solicitud",
        "de": "Bitte präzisieren Sie",
        "fr": "Veuillez préciser",
        "pt": "Esclareça, por favor",
    },
    "tool_failed": {
        "ru": "Ошибка выполнения",
        "en": "Execution failed",
        "es": "Error de ejecución",
        "de": "Ausführung fehlgeschlagen",
        "fr": "Échec de l’exécution",
        "pt": "Falha na execução",
    },
    "done": {
        "ru": "Готово",
        "en": "Done",
        "es": "Hecho",
        "de": "Fertig",
        "fr": "Terminé",
        "pt": "Concluído",
    },
}


def host_message(key: HostMessageKey) -> str:
    """Текст хоста на языке хода."""
    return t(current_locale(), HOST_MESSAGES[key])
