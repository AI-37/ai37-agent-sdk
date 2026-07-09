"""Типы StoreBackend — порт ``ts-host/src/store-backend/types.ts``.

Структурно совместимы с deepagents ``BackendProtocol`` (ls/read/grep/glob + write/edit).
Методы — async (наши бэкенды ходят httpx'ом в chat-backend). В отличие от TS, ``read_raw``
РАСШИРЕН: возвращает байты оригинала (решение Фазы 4 — Minstroy парсит xlsx через openpyxl),
а не заглушку-ошибку.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass
class FileInfo:
    path: str
    is_dir: bool | None = None
    size: int | None = None
    modified_at: str | None = None


@dataclass
class GrepMatch:
    path: str
    line: int  # 1-indexed
    text: str


@dataclass
class LsResult:
    files: list[FileInfo] | None = None
    error: str | None = None


@dataclass
class GlobResult:
    files: list[FileInfo] | None = None
    error: str | None = None


@dataclass
class ReadResult:
    content: str | bytes | None = None
    mime_type: str | None = None
    error: str | None = None


@dataclass
class ReadRawResult:
    """Raw-чтение оригинала: chat-attachments-бэкенд отдаёт байты (openpyxl/детерминизм)."""

    content: bytes | None = None
    mime_type: str | None = None
    error: str | None = None


@dataclass
class GrepResult:
    matches: list[GrepMatch] | None = None
    error: str | None = None


@dataclass
class WriteResult:
    path: str | None = None
    #: Для внешних (не-checkpoint) бэкендов — None (уже персистнуто во внешнем хранилище).
    files_update: None = None
    metadata: dict[str, Any] | None = None
    error: str | None = None


@dataclass
class EditResult:
    path: str | None = None
    files_update: None = None
    occurrences: int | None = None
    metadata: dict[str, Any] | None = None
    error: str | None = None


class StoreBackend(Protocol):
    """Read-ориентированный backend (deepagents ``CompositeBackend``-совместимый).

    write/edit присутствуют по контракту, но read-only бэкенды возвращают в них ошибку.
    """

    async def ls(self, path: str) -> LsResult: ...

    async def read(
        self, file_path: str, offset: int | None = None, limit: int | None = None
    ) -> ReadResult: ...

    async def read_raw(self, file_path: str) -> ReadRawResult: ...

    async def grep(
        self, pattern: str, path: str | None = None, glob: str | None = None
    ) -> GrepResult: ...

    async def glob(self, pattern: str, path: str | None = None) -> GlobResult: ...

    async def write(self, file_path: str, content: str) -> WriteResult: ...

    async def edit(
        self, file_path: str, old_string: str, new_string: str, replace_all: bool = False
    ) -> EditResult: ...
