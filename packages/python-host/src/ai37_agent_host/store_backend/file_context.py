"""File-aware примитив — порт ``ts-host/src/store-backend/file-context.ts``.

Generic-слой доступа к приложенным файлам поверх ``metadata.ai37.context_files``: рендер
манифеста (имена/summary) для системного промпта + маппинг ``ref`` → путь виртуальной ФС
StoreBackend. Домен-агент инжектит манифест в промпт LLM (та СРАЗУ видит имена без round-trip
к store), LLM решает по имени, надо ли читать тело, и зовёт ``read`` по пути. Тела сюда НЕ
попадают — только метаданные.
"""

from __future__ import annotations

from ..types import ContextFile

# Префикс ref → якорь виртуальной ФС StoreBackend (см. attachments-store-backend ``anchor``).
_REF_ANCHORS: tuple[tuple[str, str], ...] = (
    ("project-attachment:", "project-attachments"),
    ("chat-attachment:", "chat-attachments"),
)


def context_file_path(ref: str) -> str | None:
    """chat-attachment:<id> → /chat-attachments/<id> (аналогично project); None — не файл."""
    for prefix, anchor in _REF_ANCHORS:
        if ref.startswith(prefix):
            return f"/{anchor}/{ref[len(prefix):]}"
    return None


def render_context_files_manifest(files: list[ContextFile] | None) -> str:
    """Компактный markdown-блок ``context_files`` для системного промпта. Пустой список → ''."""
    if not files:
        return ""
    lines = ["## Приложенные к диалогу файлы", ""]
    for file in files:
        path = context_file_path(file.ref)
        location = f"`{path}`" if path else f"`{file.ref}`"
        large = " _(большой — грепай/read окнами, не целиком)_" if file.is_large else ""
        summary = f" — {file.summary.strip()}" if file.summary and file.summary.strip() else ""
        lines.append(f"- **{file.name}** — {location}{large}{summary}")
    return "\n".join(lines)
