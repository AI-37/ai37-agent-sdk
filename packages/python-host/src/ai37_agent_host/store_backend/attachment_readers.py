"""Чтение файлов хода — порт ``ts-host/src/attachments/readers.ts``.

Чтение по ref без виртуальной ФС и без LLM-петли. Под капотом те же
``Chat/ProjectAttachmentsStoreBackend``, то есть REST chat-backend с user-JWT: права проверяет он.
Читатели отдают только файлы из скоупа хода: модель не должна дотягиваться до соседних тредов по
угаданному id. Артефакты (:func:`artifact_scope`) читаются так же: только те, что были в
загруженном списке. Файлы вне хода (найденные поиском по корпусу проекта) читает
:func:`read_store_within_budget` по готовому бэкенду и пути.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Literal, Protocol

import httpx

from .artifacts_store_backend import ArtifactsStoreBackend
from .attachments_store_backend import (
    BearerFn,
    ChatAttachmentsStoreBackend,
    ProjectAttachmentsStoreBackend,
)
from .turn_files import AttachmentFile, AttachmentTurnScope
from .types import GrepResult, ReadResult

if TYPE_CHECKING:
    from .artifact_scope import ArtifactScope

#: Высота окна при чтении в бюджет. Меньше — больше запросов, больше — крупнее перебор.
WINDOW_LINES = 200
#: Страховка от бесконечного цикла, если полка всегда отвечает «есть ещё». Упор в неё —
#: ``truncated``: файл прочитан не целиком.
MAX_WINDOWS = 1000

FailureReason = Literal["access_denied", "unavailable", "reader_failed"]


class _Reader(Protocol):
    async def read(
        self, file_path: str, offset: int | None = None, limit: int | None = None
    ) -> ReadResult: ...


class _Shelf(_Reader, Protocol):
    async def grep(
        self, pattern: str, path: str | None = None, glob: str | None = None
    ) -> GrepResult: ...


@dataclass(frozen=True)
class AttachmentGrepHit:
    ref: str
    name: str
    #: Номер строки. Файлы проекта и артефакты ищет FTS chat-backend: он отдаёт сниппет без номера
    #: строки, и тогда здесь 1 — окно такого файла читается с начала.
    line: int
    text: str


@dataclass(frozen=True)
class WindowedRead:
    content: str
    #: Файл прочитан не целиком: бюджет кончился раньше текста или упёрлись в предел окон.
    truncated: bool
    error: str | None = None


@dataclass(frozen=True)
class AttachmentGrepResult:
    hits: list[AttachmentGrepHit] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


#: Полка, из которой читается файл: вложения чата и проекта, артефакты треда и проекта.
_REF_PREFIX = {
    "chat": "chat-attachment:",
    "project": "project-attachment:",
    "artifact": "artifact:",
    "project-artifact": "project-artifact:",
}


def _shelf_of(file: AttachmentFile) -> str:
    if file.kind != "artifact":
        return file.scope
    return "artifact" if file.scope == "chat" else "project-artifact"


class AttachmentReaders:
    """Читатели файлов одного хода. Создавать через :func:`create_attachment_readers`."""

    def __init__(
        self,
        scope: AttachmentTurnScope,
        shelves: dict[str, _Shelf],
    ) -> None:
        self.scope = scope
        self._shelves = shelves
        self._by_ref = {file.ref: file for file in scope.files}

    def file(self, ref: str) -> AttachmentFile | None:
        """Файл хода по ref; None — такого файла в ходе нет."""
        return self._by_ref.get(ref)

    async def read(
        self, ref: str, offset: int | None = None, limit: int | None = None
    ) -> ReadResult:
        """Окно markdown: offset/limit — номера строк (контракт полки). Без них — файл целиком."""
        file = self._by_ref.get(ref)
        if file is None:
            return ReadResult(error=f"Файла {ref} нет среди приложенных к этому ходу")
        return await self._shelves[_shelf_of(file)].read(_file_id_path(file), offset, limit)

    async def grep(self, query: str) -> AttachmentGrepResult:
        """Поиск по содержимому полок хода; совпадения только по файлам хода."""
        result = AttachmentGrepResult()
        # Полка ищет по всему треду или проекту; лишнее отсекаем по списку файлов хода.
        for kind in dict.fromkeys(_shelf_of(file) for file in self.scope.files):
            found = await self._shelves[kind].grep(query)
            if found.error:
                result.errors.append(found.error)
            for match in found.matches or []:
                file = self._by_ref.get(f"{_REF_PREFIX[kind]}{match.path.lstrip('/')}")
                if file is not None:
                    result.hits.append(
                        AttachmentGrepHit(
                            ref=file.ref,
                            name=file.name,
                            line=match.line,
                            text=_strip_source_name(match.text),
                        )
                    )
        return result

    async def read_within_budget(self, ref: str, budget_chars: int) -> WindowedRead:
        """Файл окнами до бюджета символов: ограничивает и передачу, и то, что уйдёт в модель."""

        async def window(offset: int, limit: int) -> ReadResult:
            return await self.read(ref, offset, limit)

        return await _read_windows_within_budget(window, budget_chars)


def create_attachment_readers(
    *,
    chat_backend_url: str,
    scope: AttachmentTurnScope,
    bearer: BearerFn | None = None,
    http_client: httpx.AsyncClient | None = None,
    artifacts: ArtifactScope | None = None,
) -> AttachmentReaders:
    """Читатели файлов хода. ``bearer`` по умолчанию — ``current_bearer`` из request-scope хоста;
    код вне него (фоновая задача, отдельный HTTP-сервер) передаёт токен явно.

    ``artifacts`` — артефакты треда и проекта из :func:`artifact_scope`: их файлы добавляются к
    файлам хода, и читатели, поиск и :func:`read_attachment_contents` работают с ними наравне с
    вложениями."""
    scope = _with_artifacts(scope, artifacts)
    project_id = (artifacts.project_id if artifacts else None) or scope.project_id
    artifact_context = artifacts.context_id if artifacts else scope.context_id
    shelves: dict[str, _Shelf] = {
        "chat": ChatAttachmentsStoreBackend(
            base_url=chat_backend_url,
            context_id=lambda: scope.context_id,
            bearer=bearer,
            http_client=http_client,
        ),
        "project": ProjectAttachmentsStoreBackend(
            base_url=chat_backend_url,
            project_id=lambda: scope.project_id,
            bearer=bearer,
            http_client=http_client,
        ),
        "artifact": ArtifactsStoreBackend(
            base_url=chat_backend_url,
            scope=lambda: {"contextId": artifact_context},
            bearer=bearer,
            http_client=http_client,
        ),
        "project-artifact": ArtifactsStoreBackend(
            base_url=chat_backend_url,
            scope=lambda: {"projectId": project_id} if project_id else None,
            bearer=bearer,
            http_client=http_client,
        ),
    }
    return AttachmentReaders(scope, shelves)


def _with_artifacts(
    scope: AttachmentTurnScope, artifacts: ArtifactScope | None
) -> AttachmentTurnScope:
    """Файлы хода плюс артефакты; ref, уже приложенный к ходу, второй раз не добавляется."""
    if artifacts is None or not artifacts.files:
        return scope
    refs = {file.ref for file in scope.files}
    extra = [file for file in artifacts.files if file.ref not in refs]
    return replace(scope, files=[*scope.files, *extra])


async def read_store_within_budget(backend: _Reader, path: str, budget_chars: int) -> WindowedRead:
    """Чтение окнами в бюджет по готовому бэкенду и пути, без скоупа хода. Для файлов, которые агент
    нашёл сам и к ходу они не приложены: права проверяет chat-backend."""

    async def window(offset: int, limit: int) -> ReadResult:
        return await backend.read(path, offset, limit)

    return await _read_windows_within_budget(window, budget_chars)


def attachment_failure_reason(error: object) -> FailureReason:
    """Причина отказа по тексту ошибки бэкенда. 404 значит, что полка не отдала тело; почему — из
    кода не следует (истёк TTL, не тот namespace), поэтому «недоступен», а не «удалён»."""
    text = str(error)
    if re.search(r"\b(?:401|403)\b", text):
        return "access_denied"
    if re.search(r"\b(?:404|410)\b", text):
        return "unavailable"
    return "reader_failed"


async def _read_windows_within_budget(
    read_window: Callable[[int, int], Awaitable[ReadResult]], budget_chars: int
) -> WindowedRead:
    """Окна строчные (так режет полка), бюджет символьный: пятьдесят строк бывают и пятью сотнями
    символов, и полумегабайтной таблицей. Читаем окна фиксированной высоты и останавливаемся,
    набрав бюджет; перебор последнего окна обрезаем.

    Полка (chat-backend ``windowLines``) отдаёт ``"\\n".join(lines[offset:offset + limit])``: без
    номеров строк и без признака конца файла. Пустая строка в конце окна даёт хвостовой ``\\n``, в
    начале — ведущий, поэтому ни длина окна, ни его края о конце файла ничего не говорят. Признак
    конца берём сами: просим на строку больше окна. Пришла лишняя строка — файл продолжается, её
    отбрасываем и дочитываем следующим окном; не пришла — это последнее окно."""
    if budget_chars <= 0:
        return WindowedRead(content="", truncated=True)
    parts: list[str] = []
    taken = 0
    for window in range(MAX_WINDOWS):
        result = await read_window(window * WINDOW_LINES, WINDOW_LINES + 1)
        if result.error:
            return WindowedRead(content="", truncated=False, error=result.error)
        text, more = _window_text(result.content if isinstance(result.content, str) else "")
        # Окна — куски одного split("\n"), поэтому склейка всегда через \n, даже у пустых строк.
        addition = text if window == 0 else f"\n{text}"
        if taken + len(addition) > budget_chars:
            parts.append(addition[: budget_chars - taken])
            return WindowedRead(content="".join(parts), truncated=True)
        parts.append(addition)
        taken += len(addition)
        if not more:
            return WindowedRead(content="".join(parts), truncated=False)
    # Упёрлись в страховку, а файл ещё не кончился: прочитан не целиком.
    return WindowedRead(content="".join(parts), truncated=True)


def _file_id_path(file: AttachmentFile) -> str:
    """Путь файла относительно точки монтирования полки: бэкенды mount-relative."""
    segments = [s for s in file.path.split("/") if s]
    return f"/{segments[-1] if segments else ''}"


def _strip_source_name(text: str) -> str:
    """Бэкенд кладёт имя файла в начало строки совпадения (``[имя] …``); имя у нас уже есть."""
    return re.sub(r"^\[[^\]]*\]\s*", "", text)


def _window_text(chunk: str) -> tuple[str, bool]:
    """Окно, запрошенное со строкой-разведчиком: текст без неё и признак, что файл продолжается."""
    lines = chunk.split("\n")
    if len(lines) <= WINDOW_LINES:
        return chunk, False
    return "\n".join(lines[:WINDOW_LINES]), True
