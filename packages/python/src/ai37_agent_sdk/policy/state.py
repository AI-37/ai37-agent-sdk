"""Разбор политики, объявленной переменной окружения.

Зеркало TS-модуля ``@ai37/agent-sdk`` ``policy/state.ts``.

Общее у таких гейтов — не состояния, а разбор: прочитать значение из произвольно названной
переменной, свести отсутствие, пустую строку и нераспознанное к одному и тому же исходу и взять
дефолт от вызывающего. Набор состояний у каждого гейта свой (маршрут к модели, доступ оператора,
канал вложений), поэтому он передаётся, а не зашит.

Пустую строку обязан обрабатывать именно разбор, а не схема настроек: сервисы читают окружение
напрямую, и ``''`` из ConfigMap до дефолта схемы не доезжает.
"""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class PolicyStateOptions:
    """Допустимые состояния и то, что взять, когда значения нет или оно не распознано."""

    states: Sequence[str]
    #: Обычно — закрытая сторона гейта.
    fallback: str


def parse_policy_state(raw: Any, options: PolicyStateOptions) -> str:
    """Разбор уже прочитанного значения."""
    if not isinstance(raw, str):
        return options.fallback
    value = raw.strip()
    if not value:
        return options.fallback
    return value if value in options.states else options.fallback


def read_policy_state(
    env_name: str,
    options: PolicyStateOptions,
    env: Mapping[str, str] | None = None,
) -> str:
    """Разбор значения переменной окружения. Имя переменной принадлежит вызывающему."""
    source = os.environ if env is None else env
    return parse_policy_state(source.get(env_name), options)
