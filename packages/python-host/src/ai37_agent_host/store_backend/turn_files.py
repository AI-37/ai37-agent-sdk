"""Файлы хода — порт ``ts-host/src/attachments/turn-files.ts``.

Список файлов, которые агент может прочитать в текущем ходе, собирается детерминированно из
``context_refs`` и манифеста ``context_files``: LLM в выборе путей не участвует. Читатели для этих
файлов уже есть (``ChatAttachmentsStoreBackend`` / ``ProjectAttachmentsStoreBackend``).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Literal

from ..types import ContextFile
from .file_context import context_file_path

_CHAT_PREFIX = "chat-attachment:"
_PROJECT_FILE_PREFIX = "project-attachment:"
_PROJECT_PREFIX = "project:"


@dataclass(frozen=True)
class AttachmentFile:
    """Один файл хода: адрес для чтения плюс то, что о нём известно из манифеста."""

    ref: str
    #: Путь виртуальной ФС (``/chat-attachments/<id>``).
    path: str
    #: Имя из манифеста; если манифест не пришёл — сам ref.
    name: str
    scope: Literal["chat", "project"]
    summary: str | None = None
    is_large: bool = False


@dataclass(frozen=True)
class AttachmentTurnScope:
    """namespace треда, проект хода (для манифеста и поиска по полке проекта) и файлы."""

    context_id: str
    project_id: str | None = None
    files: list[AttachmentFile] = field(default_factory=list)


def has_file_refs(refs: Iterable[str]) -> bool:
    """Есть ли в ``context_refs`` ссылки, по которым имеет смысл идти за файлами."""
    prefixes = (_CHAT_PREFIX, _PROJECT_FILE_PREFIX, _PROJECT_PREFIX)
    return any(ref.startswith(prefixes) for ref in refs)


def project_id_from_refs(refs: Iterable[str]) -> str | None:
    """projectId из ``project:<id>``; None, если ход не в проекте."""
    for ref in refs:
        if ref.startswith(_PROJECT_PREFIX):
            return ref[len(_PROJECT_PREFIX) :] or None
    return None


def attachment_scope(
    context_id: str,
    context_refs: Sequence[str] | None = None,
    context_files: Sequence[ContextFile] | None = None,
) -> AttachmentTurnScope:
    """Скоуп файлов хода: ссылки из refs и манифеста без дублей, ``project:<id>`` — не файл."""
    refs = list(context_refs or [])
    manifest = list(context_files or [])
    meta = {file.ref: file for file in manifest}
    files: dict[str, AttachmentFile] = {}
    for ref in [*refs, *(file.ref for file in manifest)]:
        if ref in files:
            continue
        file = _to_attachment_file(ref, meta.get(ref))
        if file is not None:
            files[ref] = file
    return AttachmentTurnScope(
        context_id=context_id,
        project_id=project_id_from_refs(refs),
        files=list(files.values()),
    )


def _shelf_of(ref: str) -> Literal["chat", "project"] | None:
    if ref.startswith(_CHAT_PREFIX):
        return "chat"
    if ref.startswith(_PROJECT_FILE_PREFIX):
        return "project"
    return None


def _to_attachment_file(ref: str, meta: ContextFile | None) -> AttachmentFile | None:
    scope = _shelf_of(ref)
    path = context_file_path(ref) if scope else None
    if scope is None or path is None:
        return None
    return AttachmentFile(
        ref=ref,
        path=path,
        name=(meta.name if meta and meta.name else ref),
        scope=scope,
        summary=meta.summary if meta and meta.summary else None,
        is_large=bool(meta and meta.is_large),
    )
