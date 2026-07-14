"""Протокольный ВОКАБУЛЯР формата текста (media-типы) — agent-facing SSOT.

Зеркало TS-модуля ``@ai37/agent-sdk`` ``output-modes.ts``. Этим словарём агент
декларирует ``defaultOutputModes`` в agent-card. Сама content-negotiation (выбор
формата/каталога) и enforcement — в хосте (``ai37-agent-host``); сюда вынесены только
разделяемые константы media-типов.

См. docs/ecosystem/v2/10-agui-protocol.md (РЕШЕНИЕ 10).
"""

from __future__ import annotations

#: Простой текст.
OUTPUT_MODE_TEXT = "text/plain"
#: Markdown.
OUTPUT_MODE_MARKDOWN = "text/markdown"
#: Markdown под рендерер SP-AI.
OUTPUT_MODE_MARKDOWN_SPAI = "text/vnd.markdown+spai-renderer"

#: Текстовые modes по убыванию «богатства».
TEXT_OUTPUT_MODES = (
    OUTPUT_MODE_MARKDOWN_SPAI,
    OUTPUT_MODE_MARKDOWN,
    OUTPUT_MODE_TEXT,
)

_TEXT_MODE_SET = frozenset(TEXT_OUTPUT_MODES)


def is_text_output_mode(mode: str) -> bool:
    """Является ли ``mode`` текстовым media-типом."""
    return mode in _TEXT_MODE_SET
