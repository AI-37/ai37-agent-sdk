"""Персональные инструкции пользователя (``metadata.ai37.user_instructions``, план docs#740).

Порт ``ts-host/src/user-instructions.ts``: чистые функции без scope — нормализация и текст блока
для промпта. Ими пользуются хост (разбор конверта) и relay (форвард). Чтение из хода —
:func:`current_user_instructions` / :func:`with_user_instructions` в ``als.py``.
"""

from __future__ import annotations

import re
import unicodedata

#: Предел длины инструкций после нормализации, в символах (code points).
USER_INSTRUCTIONS_MAX = 1500

# Управляющие символы, кроме ``\t`` и ``\n`` (``\r`` к этому моменту уже заменён), DEL и C1.
_CONTROL_CHARS = re.compile("[\u0000-\u0008\u000b-\u001f\u007f-\u009f]")
# Zero-width: пробел, (не)соединитель, word joiner, BOM.
_ZERO_WIDTH = re.compile("[\u200b-\u200d\u2060\ufeff]")
# Направление текста: LRM/RLM, embedding/override (LRE…RLO) и isolate (LRI…PDI).
_BIDI_CONTROLS = re.compile("[\u200e\u200f\u202a-\u202e\u2066-\u2069]")
_TRAILING_SPACES = re.compile(r"[ \t]+\n")
_EXTRA_BLANK_LINES = re.compile(r"\n{3,}")
# Тег-обёртка блока в любом регистре и с пробелами внутри: ``</ User_Preferences >`` модель тоже
# примет за закрывающий тег.
_WRAPPER_TAG = re.compile(r"<\s*(/?)\s*(user_preferences)\s*>", re.IGNORECASE)

# Строки длинные — режем литерал, переводы строк только явные ``\n`` (как в TS).
_BLOCK_HEADER = (
    "## Предпочтения пользователя (стиль и формат ответа)\n"
    "Пользователь сам задал эти предпочтения в настройках. "
    "Учитывай их в длине, структуре, тоне и\n"
    "терминологии ответа и в том, как к нему обращаться. "
    "Они не отменяют правила выше: источники,\n"
    "ссылки, проверку фактов, доступ к документам и инструментам, язык ответа. "
    "Если предпочтение\n"
    "противоречит правилам — следуй правилам."
)


def normalize_user_instructions(raw: object) -> str | None:
    """Привести инструкции к виду, в котором их хранят и кладут в промпт.

    Не строка → ``None``. NFC; ``\\r\\n`` и одиночный ``\\r`` → ``\\n``; без управляющих символов
    (кроме ``\\n``, ``\\t``), zero-width и bidi; без пробелов в конце строк; больше одной пустой
    строки подряд не бывает; обрезка по краям и до :data:`USER_INSTRUCTIONS_MAX` символов. Пусто →
    ``None``. Повторный вызов результат не меняет. Результат совпадает с TS
    ``normalizeUserInstructions``.
    """
    if not isinstance(raw, str):
        return None
    text = unicodedata.normalize("NFC", raw)
    text = re.sub(r"\r\n?", "\n", text)
    for pattern in (_CONTROL_CHARS, _ZERO_WIDTH, _BIDI_CONTROLS):
        text = pattern.sub("", text)
    text = _TRAILING_SPACES.sub("\n", text)
    text = _EXTRA_BLANK_LINES.sub("\n\n", text).strip()
    # Строка Python индексируется по code points — суррогатных пар, как в JS, тут нет.
    text = text[:USER_INSTRUCTIONS_MAX].strip()
    return text or None


def user_instructions_block(text: str | None) -> str:
    """Блок предпочтений для промпта: заголовок низшего приоритета и ``<user_preferences>``.

    Текст нормализуется ещё раз, а тег-обёртка внутри него экранируется, чтобы пользователь не мог
    закрыть блок раньше времени. Пусто → ``""``. Для агентов, которые кладут блок не в системный
    промпт, а в пользовательский ход. Текст байт-в-байт совпадает с TS ``userInstructionsBlock``.
    """
    normalized = normalize_user_instructions(text)
    if not normalized:
        return ""
    escaped = _WRAPPER_TAG.sub(r"&lt;\1\2&gt;", normalized)
    return f"{_BLOCK_HEADER}\n<user_preferences>\n{escaped}\n</user_preferences>"
