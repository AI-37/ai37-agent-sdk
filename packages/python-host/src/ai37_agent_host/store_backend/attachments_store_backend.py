"""HTTP-клиенты вложений — порт ``ts-host/src/store-backend/attachments-store-backend.ts``.

Тонкий httpx-клиент (async) к REST chat-backend. Файлы (Redis/Postgres/S3) знает только
chat-backend — единая точка auth/tenancy. Bearer форвардится из request-scope (``current_bearer``).

Расширение Фазы 4: ``ChatAttachmentsStoreBackend.read_raw`` отдаёт БАЙТЫ оригинала
(``GET /{fileId}/raw``) — для детерминированного парсинга (openpyxl). Base/project — read-only
(durable/S3 raw — follow-up).
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

import httpx

from ..als import current_bearer
from .types import (
    EditResult,
    FileInfo,
    GlobResult,
    GrepMatch,
    GrepResult,
    LsResult,
    ReadRawResult,
    ReadResult,
    WriteResult,
)

_READ_ONLY = "Вложения доступны только для чтения (агенты read-only к file:<id>)"
_RAW_UNSUPPORTED = "readRaw не поддерживается: используйте read (markdown-текст)"

BearerFn = Callable[[], str | None]


class AttachmentsStoreBackendBase:
    """База StoreBackend'ов вложений: HTTP-клиент к chat-backend. Виртуальная ФС по ``anchor``."""

    anchor: str = ""
    api_base: str = ""

    def __init__(
        self,
        *,
        base_url: str,
        bearer: BearerFn | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._bearer = bearer or current_bearer
        self._client = http_client

    # ── абстрактные резолверы scope хода ──────────────────────────────────────
    def _scope_for_manifest(self) -> dict[str, str] | None:
        raise NotImplementedError

    def _scope_for_file(self) -> dict[str, str] | None:
        raise NotImplementedError

    # ── ls ────────────────────────────────────────────────────────────────────
    async def ls(self, path: str) -> LsResult:
        if self._parse(path) != "":
            return LsResult(error=f"Не директория: {path}")
        scope = self._scope_for_manifest()
        if scope is None:
            return LsResult(error=self._scope_missing())
        try:
            data = await self._api_json("/", scope)
            return LsResult(files=[self._file_info(a) for a in data.get("attachments", [])])
        except Exception as exc:  # noqa: BLE001
            return LsResult(error=str(exc))

    # ── read (директория → манифест; файл → окно markdown) ────────────────────
    async def read(
        self, file_path: str, offset: int | None = None, limit: int | None = None
    ) -> ReadResult:
        file_id = self._parse(file_path)
        if file_id is None:
            return ReadResult(error=f"Неизвестный путь: {file_path}")
        try:
            if not file_id:
                scope = self._scope_for_manifest()
                if scope is None:
                    return ReadResult(error=self._scope_missing())
                data = await self._api_json("/", scope)
                return ReadResult(
                    content=_render_manifest(self.anchor, data.get("attachments", [])),
                    mime_type="text/markdown",
                )
            scope = self._scope_for_file()
            if scope is None:
                return ReadResult(error=self._scope_missing())
            query = dict(scope)
            if offset is not None:
                query["offset"] = str(offset)
            if limit is not None:
                query["limit"] = str(limit)
            data = await self._api_json(f"/{quote(file_id)}/content", query)
            return ReadResult(content=data.get("content", ""), mime_type="text/markdown")
        except Exception as exc:  # noqa: BLE001
            return ReadResult(error=str(exc))

    # ── glob (по имени файла, клиентский фильтр манифеста) ─────────────────────
    async def glob(self, pattern: str, path: str | None = None) -> GlobResult:
        scope = self._scope_for_manifest()
        if scope is None:
            return GlobResult(error=self._scope_missing())
        try:
            needle = re.sub(r"[*?]", "", pattern).strip().lower()
            data = await self._api_json("/", scope)
            files = [
                self._file_info(a)
                for a in data.get("attachments", [])
                if not needle or needle in str(a.get("sourceName", "")).lower()
            ]
            return GlobResult(files=files)
        except Exception as exc:  # noqa: BLE001
            return GlobResult(error=str(exc))

    # ── grep (по содержимому, серверный поиск) ────────────────────────────────
    async def grep(
        self, pattern: str, path: str | None = None, glob: str | None = None
    ) -> GrepResult:
        scope = self._scope_for_manifest()
        if scope is None:
            return GrepResult(error=self._scope_missing())
        try:
            data = await self._api_json("/search", {**scope, "q": pattern})
            matches = [
                GrepMatch(
                    path=f"/{self.anchor}/{hit['fileId']}",
                    line=int(hit.get("line", 0)),
                    text=f"[{hit.get('sourceName', '')}] {_one_line(str(hit.get('snippet', '')))}",
                )
                for hit in data.get("matches", [])
            ]
            return GrepResult(matches=matches)
        except Exception as exc:  # noqa: BLE001
            return GrepResult(error=str(exc))

    # ── read-only / raw ───────────────────────────────────────────────────────
    async def write(self, file_path: str, content: str) -> WriteResult:
        return WriteResult(error=_READ_ONLY)

    async def edit(
        self, file_path: str, old_string: str, new_string: str, replace_all: bool = False
    ) -> EditResult:
        return EditResult(error=_READ_ONLY)

    async def read_raw(self, file_path: str) -> ReadRawResult:
        return ReadRawResult(error=_RAW_UNSUPPORTED)

    # ── helpers ────────────────────────────────────────────────────────────────
    def _parse(self, path: str) -> str | None:
        """fileId сегмента (str), '' для директории-якоря, None если якорь не найден."""
        segments = [s for s in path.split("/") if s]
        if self.anchor not in segments:
            return None
        index = segments.index(self.anchor)
        return segments[index + 1] if index + 1 < len(segments) else ""

    def _file_info(self, meta: dict[str, Any]) -> FileInfo:
        return FileInfo(
            path=f"/{self.anchor}/{meta.get('fileId')}",
            is_dir=False,
            size=meta.get("bytes"),
            modified_at=meta.get("uploadedAt"),
        )

    def _scope_missing(self) -> str:
        return f"Не задан scope вложений ({self.anchor}) в текущем ходе"

    async def _request(
        self, path: str, query: dict[str, str] | None, accept: str
    ) -> httpx.Response:
        url = f"{self._base_url}{self.api_base}{path}"
        headers = {"Accept": accept}
        token = self._bearer()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if self._client is not None:
            return await self._client.get(url, params=query or {}, headers=headers)
        async with httpx.AsyncClient() as client:
            return await client.get(url, params=query or {}, headers=headers)

    async def _api_json(self, path: str, query: dict[str, str] | None = None) -> dict[str, Any]:
        resp = await self._request(path, query, "application/json")
        if resp.status_code >= 400:
            raise RuntimeError(f"chat-backend {self.api_base}{path} -> HTTP {resp.status_code}")
        return resp.json()

    async def _api_bytes(
        self, path: str, query: dict[str, str] | None = None
    ) -> tuple[bytes, str | None]:
        resp = await self._request(path, query, "application/octet-stream")
        if resp.status_code >= 400:
            raise RuntimeError(f"chat-backend {self.api_base}{path} -> HTTP {resp.status_code}")
        return resp.content, resp.headers.get("content-type")


class ChatAttachmentsStoreBackend(AttachmentsStoreBackendBase):
    """Эфемерные вложения чата (Redis TTL), якорь ``/chat-attachments/``. Namespace — contextId.

    ``read_raw`` отдаёт БАЙТЫ оригинала (Фаза 4) — для детерминированного парсинга xlsx/csv.
    """

    anchor = "chat-attachments"
    api_base = "/api/chat-attachments"

    def __init__(
        self,
        *,
        base_url: str,
        context_id: Callable[[], str | None],
        bearer: BearerFn | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(base_url=base_url, bearer=bearer, http_client=http_client)
        self._context_id = context_id

    def _scope_for_manifest(self) -> dict[str, str] | None:
        context_id = self._context_id()
        return {"contextId": context_id} if context_id else None

    def _scope_for_file(self) -> dict[str, str] | None:
        return self._scope_for_manifest()

    async def read_raw(self, file_path: str) -> ReadRawResult:
        file_id = self._parse(file_path)
        if not file_id:
            return ReadRawResult(error=f"Неизвестный путь для raw: {file_path}")
        scope = self._scope_for_file()
        if scope is None:
            return ReadRawResult(error=self._scope_missing())
        try:
            content, mime = await self._api_bytes(f"/{quote(file_id)}/raw", scope)
            return ReadRawResult(content=content, mime_type=mime)
        except Exception as exc:  # noqa: BLE001
            return ReadRawResult(error=str(exc))


class ProjectAttachmentsStoreBackend(AttachmentsStoreBackendBase):
    """Durable-вложения проекта (Postgres), якорь ``/project-attachments/``. Scope — projectId.

    ``read_raw`` — read-only (durable/S3 raw = follow-up к Фазе 4).
    """

    anchor = "project-attachments"
    api_base = "/api/project-attachments"

    def __init__(
        self,
        *,
        base_url: str,
        project_id: Callable[[], str | None],
        bearer: BearerFn | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(base_url=base_url, bearer=bearer, http_client=http_client)
        self._project_id = project_id

    def _scope_for_manifest(self) -> dict[str, str] | None:
        project_id = self._project_id()
        return {"projectId": project_id} if project_id else None

    def _scope_for_file(self) -> dict[str, str] | None:
        # read по fileId не требует projectId — chat-backend резолвит в скоупе владельца.
        return {}


def _render_manifest(anchor: str, attachments: list[dict[str, Any]]) -> str:
    lines = [f"# Вложения ({anchor})", ""]
    for meta in attachments:
        flags = " _(большой — грепай, не читай целиком)_" if meta.get("isLarge") else ""
        lines.append(f"- **{meta.get('sourceName')}** — `/{anchor}/{meta.get('fileId')}`{flags}")
        if meta.get("summary"):
            lines.append(f"  - {meta['summary']}")
    if not attachments:
        lines.append("_нет вложений_")
    return "\n".join(lines)


def _one_line(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()[:200]
