"""Маскировка секретов в логах агентов — парити с TS ``log-redaction.ts``.

Два способа на двух уровнях (docs plans/agent-log-secret-redaction.md): по имени поля — здесь, в
процессе (ловит секрет любого формата); по виду значения широко (сотни правил gitleaks) — в
сборщике логов кластера. Здесь только три дешёвые регулярки как страховка.
"""

from __future__ import annotations

import logging
import re
from typing import Any

REDACTED = "[REDACTED]"

#: Имя поля, строковое значение которого в лог не попадает. Только строки: числа вроде
#: ``remaining_total_tokens`` остаются.
SECRET_KEY_PATTERN = re.compile(
    r"token|secret|passw|pwd|api[-_]?key|llm[-_]?key|private[-_]?key|access[-_]?key"
    r"|authorization|cookie|credential",
    re.IGNORECASE,
)

_VALUE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*"), REDACTED),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE), f"Bearer {REDACTED}"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"), REDACTED),
)

_MAX_DEPTH = 10


def redact_secrets_in_text(text: str) -> str:
    """Секреты, узнаваемые по виду (JWT, ``Bearer …``, ``sk-…``), в произвольной строке."""
    for pattern, replacement in _VALUE_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def _walk(value: Any, depth: int, seen: set[int]) -> Any:
    if isinstance(value, str):
        return redact_secrets_in_text(value)
    if not isinstance(value, dict | list | tuple):
        log_view = getattr(value, "log_view", None)
        return _walk(log_view(), depth, seen) if callable(log_view) else value
    if depth > _MAX_DEPTH:
        return "[MaxDepth]"
    if id(value) in seen:
        return "[Circular]"
    seen.add(id(value))
    if isinstance(value, dict):
        return {
            key: REDACTED
            if isinstance(item, str) and SECRET_KEY_PATTERN.search(str(key))
            else _walk(item, depth + 1, seen)
            for key, item in value.items()
        }
    items = [_walk(item, depth + 1, seen) for item in value]
    return items if isinstance(value, list) else tuple(items)


def redact_for_log(value: Any) -> Any:
    """Копия значения для лога: строковые значения «секретных» полей заменены на ``[REDACTED]``
    на любой глубине, JWT / Bearer / ``sk-…`` вырезаны из всех строк. Объект с ``log_view()``
    (``AgentContext``) заменяется его выжимкой. Исходник не меняется."""
    return _walk(value, 0, set())


class SecretRedactingFilter(logging.Filter):
    """``logging.Filter``: маскирует текст сообщения, аргументы форматирования и поля ``extra``.

    Подключение: ``handler.addFilter(SecretRedactingFilter())`` — на handler, чтобы покрыть записи
    всех логгеров, которые через него проходят.
    """

    _STANDARD = frozenset(vars(logging.LogRecord("", 0, "", 0, "", None, None)))

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_secrets_in_text(record.msg)
        if isinstance(record.args, dict):
            record.args = redact_for_log(record.args)
        elif isinstance(record.args, tuple):
            record.args = tuple(redact_for_log(list(record.args)))
        for key, value in list(vars(record).items()):
            if key in self._STANDARD or key in {"message", "asctime"}:
                continue
            if isinstance(value, str) and SECRET_KEY_PATTERN.search(key):
                setattr(record, key, REDACTED)
            else:
                setattr(record, key, redact_for_log(value))
        return True
