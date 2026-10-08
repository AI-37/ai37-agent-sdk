"""Read-only StoreBackend артефактов агентов.

Порт ``ts-host/src/store-backend/artifacts-store-backend.ts``.

Тонкий httpx-клиент к ``/api/artifacts`` chat-backend с форвардом user-JWT, по образцу
``ProjectAttachmentsStoreBackend``. Доступ решает chat-backend: чужой артефакт — 404.

Инвариант ADR 13: артефакты не приходят в ``context_files``; агент видит их, только если ему дали
явный ref (``artifact:<id>`` / ``project-artifact:<id>``) или смонтировали корпус проекта.

Виртуальная ФС (пути относительно точки монтирования):
  * ``/`` — манифест артефактов корпуса (``ls`` структурно, ``read`` — markdown);
  * ``/<id>`` — ``read`` окна markdown (корпус не нужен — адрес по id);
  * ``/<id>/<fileId>`` — ``read_raw``: байты бинарного файла артефакта;
  * ``grep`` — FTS chat-backend; ``glob`` — по имени; ``write``/``edit`` — ошибка.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any
from urllib.parse import quote, unquote

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

_READ_ONLY = "Артефакты неизменяемы: агенты читают их, но не пишут (публикация — publish_artifact)"
_SCOPE_MISSING = "Не задан корпус артефактов (contextId или projectId) в текущем ходе"
_FILENAME_RE = re.compile(r"filename\*=UTF-8''([^;]+)", re.IGNORECASE)

#: Корпус: ``{"contextId": ...}`` (свои артефакты чата диалога) или ``{"projectId": ...}``.
ScopeFn = Callable[[], dict[str, str] | None]


class ArtifactsStoreBackend:
    """Выходная полка артефактов агентов для ``CompositeBackend`` (read-only)."""

    def __init__(
        self,
        *,
        base_url: str,
        scope: ScopeFn,
        bearer: Callable[[], str | None] | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._scope = scope
        self._bearer = bearer or current_bearer
        self._client = http_client

    async def ls(self, path: str) -> LsResult:
        if _segments(path):
            return LsResult(error=f"Не директория: {path}")
        try:
            artifacts = await self._manifest()
        except _NoScope:
            return LsResult(error=_SCOPE_MISSING)
        except Exception as exc:  # noqa: BLE001
            return LsResult(error=str(exc))
        return LsResult(files=[_file_info(a) for a in artifacts])

    async def read(
        self, file_path: str, offset: int | None = None, limit: int | None = None
    ) -> ReadResult:
        seg = _segments(file_path)
        if len(seg) > 1:
            return ReadResult(error=f"Неизвестный путь: {file_path}")
        try:
            if not seg:
                artifacts = await self._manifest()
                return ReadResult(content=_render_manifest(artifacts), mime_type="text/markdown")
            query: dict[str, str] = {}
            if offset is not None:
                query["offset"] = str(offset)
            if limit is not None:
                query["limit"] = str(limit)
            data = await self._json(f"/{quote(seg[0])}/content", query)
            return ReadResult(content=data.get("content", ""), mime_type="text/markdown")
        except _NoScope:
            return ReadResult(error=_SCOPE_MISSING)
        except Exception as exc:  # noqa: BLE001
            return ReadResult(error=str(exc))

    async def glob(self, pattern: str, path: str | None = None) -> GlobResult:
        needle = re.sub(r"[*?]", "", pattern).strip().lower()
        try:
            artifacts = await self._manifest()
        except _NoScope:
            return GlobResult(error=_SCOPE_MISSING)
        except Exception as exc:  # noqa: BLE001
            return GlobResult(error=str(exc))
        return GlobResult(
            files=[
                _file_info(a)
                for a in artifacts
                if not needle or needle in str(a.get("name", "")).lower()
            ]
        )

    async def grep(
        self, pattern: str, path: str | None = None, glob: str | None = None
    ) -> GrepResult:
        scope = self._scope()
        if not scope:
            return GrepResult(error=_SCOPE_MISSING)
        try:
            data = await self._json("/search", {**scope, "q": pattern})
        except Exception as exc:  # noqa: BLE001
            return GrepResult(error=str(exc))
        return GrepResult(
            # FTS не знает номера строки — как у файлов проекта, line = 1.
            matches=[
                GrepMatch(
                    path=f"/{hit['id']}",
                    line=1,
                    text=f"[{hit.get('name', '')}] {_one_line(str(hit.get('snippet', '')))}",
                )
                for hit in data.get("matches", [])
            ]
        )

    async def write(self, file_path: str, content: str) -> WriteResult:
        return WriteResult(error=_READ_ONLY)

    async def edit(
        self, file_path: str, old_string: str, new_string: str, replace_all: bool = False
    ) -> EditResult:
        return EditResult(error=_READ_ONLY)

    async def read_raw(self, file_path: str) -> ReadRawResult:
        """Байты файла артефакта по пути ``/<id>/<fileId>`` (детерминированный разбор, не LLM)."""
        seg = _segments(file_path)
        if len(seg) != 2:
            return ReadRawResult(error=f"Путь файла артефакта — /<id>/<fileId>: {file_path}")
        body = await self.read_file(seg[0], seg[1])
        if "error" in body:
            return ReadRawResult(error=str(body["error"]))
        return ReadRawResult(content=body["data"], mime_type=body["mime"])

    async def read_file(self, artifact_id: str, file_id: str) -> dict[str, Any]:
        """Файл артефакта: ``{data, mime, file_name}`` или ``{error}`` (как TS ``readFile``)."""
        try:
            resp = await self._request(f"/{quote(artifact_id)}/files/{quote(file_id)}", None, "*/*")
        except Exception as exc:  # noqa: BLE001
            return {"error": str(exc)}
        match = _FILENAME_RE.search(resp.headers.get("content-disposition", ""))
        return {
            "data": resp.content,
            "mime": resp.headers.get("content-type", "application/octet-stream"),
            "file_name": unquote(match.group(1)) if match else file_id,
        }

    async def meta(self, artifact_id: str) -> dict[str, Any]:
        """Метаданные артефакта по id или ``{error}``."""
        try:
            data = await self._json(f"/{quote(artifact_id)}")
        except Exception as exc:  # noqa: BLE001
            return {"error": str(exc)}
        artifact = data.get("artifact")
        return artifact if isinstance(artifact, dict) else {"error": "нет artifact в ответе"}

    # ── helpers ────────────────────────────────────────────────────────────────

    async def _manifest(self) -> list[dict[str, Any]]:
        scope = self._scope()
        if not scope:
            raise _NoScope
        data = await self._json("", scope)
        artifacts = data.get("artifacts", [])
        return artifacts if isinstance(artifacts, list) else []

    async def _json(self, path: str, query: dict[str, str] | None = None) -> dict[str, Any]:
        resp = await self._request(path, query, "application/json")
        data = resp.json()
        return data if isinstance(data, dict) else {}

    async def _request(
        self, path: str, query: dict[str, str] | None, accept: str
    ) -> httpx.Response:
        url = f"{self._base_url}/api/artifacts{path}"
        headers = {"Accept": accept}
        token = self._bearer()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if self._client is not None:
            resp = await self._client.get(url, params=query or {}, headers=headers)
        else:
            async with httpx.AsyncClient() as client:
                resp = await client.get(url, params=query or {}, headers=headers)
        if resp.status_code >= 400:
            raise RuntimeError(f"chat-backend /api/artifacts{path} -> HTTP {resp.status_code}")
        return resp


class _NoScope(Exception):
    """Корпус хода не задан (резолвер вернул None)."""


def _segments(path: str) -> list[str]:
    return [s for s in path.split("/") if s]


def _file_info(meta: dict[str, Any]) -> FileInfo:
    return FileInfo(path=f"/{meta.get('id')}", is_dir=False, modified_at=meta.get("createdAt"))


def _render_manifest(artifacts: list[dict[str, Any]]) -> str:
    lines = ["# Артефакты", ""]
    for a in artifacts:
        flags = " _(большой — грепай, не читай целиком)_" if a.get("isLarge") else ""
        lines.append(f"- **{a.get('name')}** ({a.get('kind')}) — `/{a.get('id')}`{flags}")
        if a.get("summary"):
            lines.append(f"  - {a['summary']}")
        files = a.get("files") or []
        if files:
            lines.append(f"  - файлы: {', '.join(str(f.get('fileName')) for f in files)}")
    if not artifacts:
        lines.append("_нет артефактов_")
    return "\n".join(lines)


def _one_line(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()[:200]
