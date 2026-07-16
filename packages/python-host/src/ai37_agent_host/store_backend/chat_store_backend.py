"""История чатов/проектов — порт ``ts-host/src/store-backend/chat-store-backend.ts``.

Read-only StoreBackend поверх history-API chat-backend: агент читает историю чатов и проекты
пользователя через файловую абстракцию deepagents ``CompositeBackend``. ВСЕ операции серверные
(включая поиск) — backend лишь маппит virtual-path + query на REST-endpoint и форматирует ответ.
Чат — основная сущность, проект — опциональная группировка.

Виртуальная ФС (якоря ``projects``/``threads`` в пути):
``/projects/``, ``/projects/{slug}/``, ``/projects/{slug}/threads/``,
``/projects/{slug}/threads/{ts}/``, ``/threads/``, ``/threads/{ts}/``.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
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

_READ_ONLY = "ChatStoreBackend доступен только для чтения (история чатов/проектов)"

BearerFn = Callable[[], str | None]


class ChatStoreBackend:
    """Read-only backend истории (deepagents ``CompositeBackend``-совместимый).

    Монтируется под якорь (напр. ``/history/``); parse толерантен к обрезке префикса
    ``CompositeBackend`` — якоря ищутся среди сегментов пути.
    """

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

    # ── ls ──────────────────────────────────────────────────────────────────────
    async def ls(self, path: str) -> LsResult:
        try:
            p = _parse_path(path)
            kind = p.kind
            if kind == "root":
                return LsResult(files=[_dir("/projects/"), _dir("/threads/")])
            if kind == "projects":
                data = await self._api("/api/projects/")
                return LsResult(files=[_dir(_project_dir(pr)) for pr in data.get("projects", [])])
            if kind == "project":
                return LsResult(files=[_dir(f"/projects/{p.project_slug}/threads/")])
            if kind == "project-threads":
                data = await self._api(f"/api/projects/{_enc(p.project_slug)}/threads/")
                return LsResult(
                    files=[
                        _thread_file(f"/projects/{p.project_slug}/threads/{_thread_seg(t)}", t)
                        for t in data.get("threads", [])
                    ]
                )
            if kind == "threads":
                data = await self._api("/api/threads/", {"projectId": "none"})
                return LsResult(
                    files=[
                        _thread_file(f"/threads/{_thread_seg(t)}", t)
                        for t in data.get("threads", [])
                    ]
                )
            return LsResult(error=f"Не директория: {path}")
        except Exception as exc:  # noqa: BLE001
            return LsResult(error=str(exc))

    # ── read ────────────────────────────────────────────────────────────────────
    async def read(
        self, file_path: str, offset: int | None = None, limit: int | None = None
    ) -> ReadResult:
        try:
            md = await self._render_read(_parse_path(file_path))
            if md is None:
                return ReadResult(error=f"Не найдено: {file_path}")
            return ReadResult(content=_slice_lines(md, offset, limit), mime_type="text/markdown")
        except Exception as exc:  # noqa: BLE001
            return ReadResult(error=str(exc))

    # ── glob (по имени, серверный ILIKE) ─────────────────────────────────────────
    async def glob(self, pattern: str, path: str | None = None) -> GlobResult:
        try:
            name = _strip_glob(pattern)
            p = _parse_path(path or "/")
            if p.kind in ("root", "projects"):
                data = await self._api("/api/projects/", {"name": name})
                return GlobResult(files=[_dir(_project_dir(pr)) for pr in data.get("projects", [])])
            if p.kind in ("project", "project-threads"):
                data = await self._api(
                    f"/api/projects/{_enc(p.project_slug)}/threads/", {"name": name}
                )
                return GlobResult(
                    files=[
                        _thread_file(f"/projects/{p.project_slug}/threads/{_thread_seg(t)}", t)
                        for t in data.get("threads", [])
                    ]
                )
            if p.kind == "threads":
                data = await self._api("/api/threads/", {"name": name, "projectId": "none"})
                return GlobResult(
                    files=[
                        _thread_file(f"/threads/{_thread_seg(t)}", t)
                        for t in data.get("threads", [])
                    ]
                )
            return GlobResult(files=[])
        except Exception as exc:  # noqa: BLE001
            return GlobResult(error=str(exc))

    # ── grep (по содержимому, серверный FTS) ─────────────────────────────────────
    async def grep(
        self, pattern: str, path: str | None = None, glob: str | None = None
    ) -> GrepResult:
        try:
            p = _parse_path(path or "/")
            if p.kind in ("project", "project-threads"):
                data = await self._api(
                    f"/api/projects/{_enc(p.project_slug)}/threads/", {"content": pattern}
                )
            elif p.kind == "threads":
                data = await self._api("/api/threads/", {"content": pattern, "projectId": "none"})
            else:
                data = await self._api("/api/projects/", {"content": pattern})
            matches = []
            for hit in data.get("matches", []):
                title = hit.get("threadTitle") or "чат"
                snippet = _one_line(str(hit.get("snippet", "")))
                matches.append(
                    GrepMatch(path=_grep_hit_path(hit), line=1, text=f"[{title}] {snippet}")
                )
            return GrepResult(matches=matches)
        except Exception as exc:  # noqa: BLE001
            return GrepResult(error=str(exc))

    # ── read-only ─────────────────────────────────────────────────────────────────
    async def write(self, file_path: str, content: str) -> WriteResult:
        return WriteResult(error=_READ_ONLY)

    async def edit(
        self, file_path: str, old_string: str, new_string: str, replace_all: bool = False
    ) -> EditResult:
        return EditResult(error=_READ_ONLY)

    async def read_raw(self, file_path: str) -> ReadRawResult:
        return ReadRawResult(error=_READ_ONLY)

    # ── рендереры read ──────────────────────────────────────────────────────────────
    async def _render_read(self, p: _Parsed) -> str | None:
        kind = p.kind
        if kind in ("root", "projects"):
            data = await self._api("/api/projects/")
            header = "# История" if kind == "root" else "# Проекты"
            lines = [header, ""]
            if kind == "root":
                lines.append("## Проекты")
            for pr in data.get("projects", []):
                lines.append(f"- {pr.get('title')} — `/projects/{_proj_seg(pr)}/`")
            if not data.get("projects"):
                lines.append("_нет проектов_")
            if kind == "root":
                lines += ["", "## Чаты вне проектов — `/threads/`"]
            return "\n".join(lines)
        if kind == "project":
            project = (await self._api(f"/api/projects/{_enc(p.project_slug)}/")).get("project", {})
            threads = (await self._api(f"/api/projects/{_enc(p.project_slug)}/threads/")).get(
                "threads", []
            )
            return _render_thread_list(
                f"# Проект: {project.get('title')}", threads, f"/projects/{p.project_slug}/threads"
            )
        if kind == "project-threads":
            threads = (await self._api(f"/api/projects/{_enc(p.project_slug)}/threads/")).get(
                "threads", []
            )
            return _render_thread_list(
                "# Чаты проекта", threads, f"/projects/{p.project_slug}/threads"
            )
        if kind == "threads":
            threads = (await self._api("/api/threads/", {"projectId": "none"})).get("threads", [])
            return _render_thread_list("# Чаты вне проектов", threads, "/threads")
        if kind == "project-thread":
            messages = (
                await self._api(
                    f"/api/projects/{_enc(p.project_slug)}/threads/{_enc(p.thread_slug)}"
                )
            ).get("messages", [])
            return _render_chat(p.thread_slug, messages)
        if kind == "thread":
            messages = (await self._api(f"/api/threads/{_enc(p.thread_slug)}")).get("messages", [])
            return _render_chat(p.thread_slug, messages)
        return None

    # ── HTTP ─────────────────────────────────────────────────────────────────────
    async def _api(self, path: str, query: dict[str, str] | None = None) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        headers = {"Accept": "application/json"}
        token = self._bearer()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        params = {k: v for k, v in (query or {}).items() if v is not None}
        if self._client is not None:
            resp = await self._client.get(url, params=params, headers=headers)
        else:
            async with httpx.AsyncClient() as client:
                resp = await client.get(url, params=params, headers=headers)
        if resp.status_code >= 400:
            raise RuntimeError(f"chat-backend {path} -> HTTP {resp.status_code}")
        return resp.json()


# ── path parsing (толерантно к scope-обрезке: якоря ищутся в сегментах) ──────────────
@dataclass
class _Parsed:
    kind: str
    project_slug: str = ""
    thread_slug: str = ""


def _parse_path(path: str) -> _Parsed:
    seg = [s for s in path.split("/") if s]
    if not seg:
        return _Parsed("root")
    anchors = [i for i, s in enumerate(seg) if s in ("projects", "threads")]
    if not anchors:
        return _Parsed("unknown")
    i = anchors[0]
    if seg[i] == "projects":
        if i + 1 >= len(seg):
            return _Parsed("projects")
        project_slug = seg[i + 1]
        if i + 2 >= len(seg):
            return _Parsed("project", project_slug=project_slug)
        if seg[i + 2] == "threads":
            if i + 3 < len(seg):
                return _Parsed(
                    "project-thread", project_slug=project_slug, thread_slug=seg[i + 3]
                )
            return _Parsed("project-threads", project_slug=project_slug)
        return _Parsed("unknown")
    if i + 1 < len(seg):
        return _Parsed("thread", thread_slug=seg[i + 1])
    return _Parsed("threads")


# ── helpers ──────────────────────────────────────────────────────────────────────────
def _dir(path: str) -> FileInfo:
    return FileInfo(path=path, is_dir=True)


def _thread_file(path: str, t: dict[str, Any]) -> FileInfo:
    return FileInfo(path=path, is_dir=False, modified_at=t.get("updatedAt"))


def _proj_seg(p: dict[str, Any]) -> str:
    return p.get("slug") or p.get("id") or ""


def _project_dir(p: dict[str, Any]) -> str:
    return f"/projects/{_proj_seg(p)}/"


def _thread_seg(t: dict[str, Any]) -> str:
    return t.get("slug") or t.get("contextId") or ""


def _grep_hit_path(hit: dict[str, Any]) -> str:
    ts = hit.get("threadSlug") or hit.get("contextId") or ""
    project_slug = hit.get("projectSlug")
    return f"/projects/{project_slug}/threads/{ts}" if project_slug else f"/threads/{ts}"


def _render_thread_list(header: str, threads: list[dict[str, Any]], base: str) -> str:
    lines = [header, ""]
    for t in threads:
        title = t.get("title") or "Без названия"
        lines.append(f"- {title} — `{base}/{_thread_seg(t)}` (обновлён: {t.get('updatedAt')})")
    if not threads:
        lines.append("_нет чатов_")
    return "\n".join(lines)


def _render_chat(slug: str, messages: list[dict[str, Any]]) -> str:
    roles = {"user": "Пользователь", "assistant": "Ассистент"}
    lines = [f"# Чат {slug}", ""]
    for m in messages:
        role = roles.get(m.get("role", ""), m.get("role", ""))
        content = m.get("content") if isinstance(m.get("content"), str) else ""
        lines += [f"**{role}:** {content}", ""]
    if not messages:
        lines.append("_пусто_")
    return "\n".join(lines)


def _enc(s: str) -> str:
    return quote(s, safe="")


def _one_line(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()[:200]


def _strip_glob(pattern: str) -> str:
    """glob-маска → подстрока для серверного ILIKE (спецсимволы glob убираем)."""
    return re.sub(r"[*?]", "", pattern).strip()


def _slice_lines(content: str, offset: int | None, limit: int | None) -> str:
    if not offset and limit is None:
        return content
    lines = content.split("\n")
    start = offset or 0
    end = len(lines) if limit is None else start + limit
    return "\n".join(lines[start:end])
