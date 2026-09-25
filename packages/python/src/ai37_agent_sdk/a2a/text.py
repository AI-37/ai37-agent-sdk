from __future__ import annotations


def compact_text(value: str) -> str:
    """Санитайзер строк карточки агента: карточку пишет агент, которым мы не управляем, а витрина
    печатает её текст пользователю — поэтому убираем управляющие символы и угловые скобки, а
    пробелы сводим к одному."""
    safe = "".join(
        " " if ord(character) < 32 or ord(character) == 127 else character for character in value
    )
    return " ".join(safe.replace("<", " ").replace(">", " ").split())
