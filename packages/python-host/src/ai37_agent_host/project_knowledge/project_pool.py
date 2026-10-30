"""Пул проекта в document-service — порт ``ts-host/src/project-knowledge/project-pool.ts``.

Загрузка файла и поиск документа по названию (план project-knowledge-bridge, срез 2; контракт DS —
``POST/GET /api/project-pools/{projectKey}/documents``). Мост chat-backend грузит с JWT
пользователя, фоновые задачи агентов — со служебным токеном (:func:`service_token`). Организацию
запрос не передаёт: DS берёт её из токена или из записи пула.
"""

from __future__ import annotations

import os
import re
from collections.abc import AsyncIterable, AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import quote

import anyio
import httpx

#: Файл: байты, путь на диске, открытый бинарный файл или асинхронный поток байтов. Путь и файл
#: читаются потоком; у асинхронного потока размер передаётся явно (``size=``).
ProjectPoolFile = bytes | os.PathLike[str] | BinaryIO | AsyncIterable[bytes]

_CHUNK = 256 * 1024
_CODE_RE = re.compile(r"^[\w.:-]{1,64}$")
#: Страница по максимуму DS и потолок страниц: поиск подстрочный, точное имя ищем среди найденного.
_PAGE_SIZE = 50
_MAX_PAGES = 20


class ProjectPoolError(Exception):
    """Отказ DS. ``code`` — код из тела ответа DS как есть (``pool_not_found``,
    ``ambiguous_project_pool``, ``documents_not_in_plan``, ``upload_busy``, …); свои коды SDK —
    ``network_error`` и ``upstream_error`` (ответ без кода). Текст ответа и имя файла в сообщение не
    попадают."""

    def __init__(
        self,
        code: str,
        status: int | None = None,
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(f"project pool: {code}{f' (HTTP {status})' if status else ''}")
        self.code = code
        self.status = status
        #: Через сколько секунд повторить (``upload_busy``): из ``Retry-After``, иначе из тела.
        self.retry_after_seconds = retry_after_seconds


@dataclass(frozen=True)
class ProjectPoolDuplicate:
    """Документ с тем же содержимым (sha256) уже в пуле: DS ответил 409 ``duplicate``."""

    #: id серии документа в DS.
    id: str
    title: str


@dataclass(frozen=True)
class ProjectPoolUploadResult:
    """Ровно одно поле заполнено: ``series_id`` (принят) или ``duplicate_of`` (уже был)."""

    series_id: str | None = None
    duplicate_of: ProjectPoolDuplicate | None = None


@dataclass(frozen=True)
class ProjectPoolDocument:
    """Строка реестра пула (``GET /api/project-pools/{key}/documents``)."""

    #: id серии документа в DS.
    id: str
    title: str
    #: ``queued`` | ``processing`` | ``ready`` | ``empty`` | ``error`` | ``stopped``.
    state: str
    stage: str = ""
    created_at: str = ""
    page_count: int = 0
    ready_pages: int = 0
    author: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)


async def upload_to_project_pool(
    *,
    document_service_url: str,
    project_key: str,
    file: ProjectPoolFile,
    file_name: str,
    bearer: str,
    project_name: str | None = None,
    size: int | None = None,
    content_type: str | None = None,
    http_client: httpx.AsyncClient | None = None,
    timeout: float = 120.0,
) -> ProjectPoolUploadResult:
    """Загружает файл в пул проекта DS телом без multipart: имя в ``X-File-Name``
    (urlencoded), размер в ``Content-Length``. Повтор того же содержимого не ошибка — DS отвечает
    ``duplicate``, и в результате ``duplicate_of``.

    ``content_type`` по умолчанию ``application/pdf`` для ``.pdf``, иначе
    ``application/octet-stream``: DS принимает PDF только с точным типом, остальные форматы
    проверяет по содержимому. ``size`` обязателен только для асинхронного потока."""
    body, length = _upload_body(file, size)
    headers = {
        "Authorization": f"Bearer {bearer}",
        "Accept": "application/json",
        "Content-Type": content_type or _default_content_type(file_name),
        "Content-Length": str(length),
        "X-File-Name": quote(file_name, safe=""),
    }
    if project_name:
        headers["X-Project-Name"] = quote(project_name, safe="")
    # Поток httpx отправил бы chunked, но Content-Length задан, и тело уходит с длиной.
    request = httpx.Request(
        "POST", _pool_url(document_service_url, project_key), headers=headers, content=body
    )
    resp = await _send(request, http_client, timeout)
    payload = _json(resp)
    if resp.status_code == 201:
        series_id = payload.get("id")
        if not isinstance(series_id, str) or not series_id:
            raise ProjectPoolError("upstream_error", resp.status_code)
        return ProjectPoolUploadResult(series_id=series_id)
    duplicate = _duplicate_of(resp.status_code, payload)
    if duplicate is not None:
        return ProjectPoolUploadResult(duplicate_of=duplicate)
    raise _pool_error(resp, payload)


async def find_project_document_by_title(
    *,
    document_service_url: str,
    project_key: str,
    title: str,
    bearer: str,
    http_client: httpx.AsyncClient | None = None,
    timeout: float = 30.0,
) -> ProjectPoolDocument | None:
    """Документ пула с точно таким названием (имя файла без расширения) или None. DS ищет по
    подстроке без учёта регистра, поэтому выдача сверяется с названием целиком; страницы
    листаются, пока совпадение не найдено. Пула ещё нет — DS отдаёт пустую страницу."""
    wanted = title.strip()
    headers = {"Authorization": f"Bearer {bearer}", "Accept": "application/json"}
    cursor: str | None = None
    for _ in range(_MAX_PAGES):
        params = {"search": wanted, "take": str(_PAGE_SIZE)}
        if cursor:
            params["cursor"] = cursor
        request = httpx.Request(
            "GET", _pool_url(document_service_url, project_key), params=params, headers=headers
        )
        resp = await _send(request, http_client, timeout)
        payload = _json(resp)
        if resp.status_code >= 400:
            raise _pool_error(resp, payload)
        documents = payload.get("documents")
        if not isinstance(documents, list):
            raise ProjectPoolError("upstream_error", resp.status_code)
        found = next(
            (d for d in documents if isinstance(d, dict) and d.get("title") == wanted), None
        )
        if found is not None:
            return _document(found)
        cursor = payload.get("nextCursor") or None
        if not cursor:
            return None
    return None


# ── helpers ──────────────────────────────────────────────────────────────────────


def _upload_body(
    file: ProjectPoolFile, size: int | None
) -> tuple[bytes | AsyncIterable[bytes], int]:
    if isinstance(file, bytes | bytearray | memoryview):
        data = bytes(file)
        return data, len(data)
    if isinstance(file, os.PathLike):
        path = Path(file)
        return _path_chunks(path), size if size is not None else path.stat().st_size
    if hasattr(file, "read"):
        binary: BinaryIO = file  # type: ignore[assignment]
        return _binary_chunks(binary), size if size is not None else _remaining(binary)
    if size is None:
        raise ValueError("upload_to_project_pool: для асинхронного потока нужен size")
    return file, size


async def _path_chunks(path: Path) -> AsyncIterator[bytes]:
    async with await anyio.open_file(path, "rb") as handle:
        while chunk := await handle.read(_CHUNK):
            yield chunk


async def _binary_chunks(binary: BinaryIO) -> AsyncIterator[bytes]:
    while chunk := await anyio.to_thread.run_sync(binary.read, _CHUNK):
        yield chunk


def _remaining(binary: BinaryIO) -> int:
    """Сколько байт осталось от текущей позиции до конца файла."""
    position = binary.tell()
    end = binary.seek(0, os.SEEK_END)
    binary.seek(position)
    return end - position


def _default_content_type(file_name: str) -> str:
    return (
        "application/pdf"
        if file_name.strip().lower().endswith(".pdf")
        else ("application/octet-stream")
    )


def _pool_url(base_url: str, project_key: str) -> str:
    return f"{base_url.rstrip('/')}/api/project-pools/{quote(project_key, safe='')}/documents"


async def _send(
    request: httpx.Request, http_client: httpx.AsyncClient | None, timeout: float
) -> httpx.Response:
    request.extensions["timeout"] = httpx.Timeout(timeout).as_dict()
    try:
        if http_client is not None:
            return await http_client.send(request)
        async with httpx.AsyncClient() as client:
            return await client.send(request)
    except httpx.HTTPError as exc:
        raise ProjectPoolError("network_error") from exc


def _json(resp: httpx.Response) -> dict[str, Any]:
    try:
        data = resp.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _duplicate_of(status: int, payload: dict[str, Any]) -> ProjectPoolDuplicate | None:
    duplicate = payload.get("duplicate")
    if status != 409 or payload.get("code") != "duplicate" or not isinstance(duplicate, dict):
        return None
    dup_id, title = duplicate.get("id"), duplicate.get("title")
    if not isinstance(dup_id, str) or not dup_id:
        return None
    return ProjectPoolDuplicate(id=dup_id, title=title if isinstance(title, str) else "")


def _pool_error(resp: httpx.Response, payload: dict[str, Any]) -> ProjectPoolError:
    code = payload.get("code")
    # Только короткий машинный код: произвольный текст ответа в ошибку не тащим.
    known = code if isinstance(code, str) and _CODE_RE.match(code) else "upstream_error"
    return ProjectPoolError(known, resp.status_code, _retry_after(resp, payload))


def _retry_after(resp: httpx.Response, payload: dict[str, Any]) -> float | None:
    try:
        header = float(resp.headers.get("retry-after", ""))
    except ValueError:
        header = 0.0
    if header > 0:
        return header
    from_body = payload.get("retryAfterSeconds")
    if isinstance(from_body, int | float) and not isinstance(from_body, bool) and from_body > 0:
        return float(from_body)
    return None


def _document(row: dict[str, Any]) -> ProjectPoolDocument:
    return ProjectPoolDocument(
        id=str(row.get("id", "")),
        title=str(row.get("title", "")),
        state=str(row.get("state", "")),
        stage=str(row.get("stage", "")),
        created_at=str(row.get("createdAt", "")),
        page_count=int(row.get("pageCount") or 0),
        ready_pages=int(row.get("readyPages") or 0),
        author=row.get("author") if isinstance(row.get("author"), str) else None,
        raw=row,
    )
