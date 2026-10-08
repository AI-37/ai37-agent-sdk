"""Публикация артефакта — порт ``ts-host/src/artifacts/publish-artifact.ts``.

Агент сдаёт результат хода в выходную полку chat-backend (``POST /api/artifacts``, план
files-and-artifacts-layer §3.3) от имени пользователя: user-JWT и диалог берутся из request-scope
хода. Без них публикация отказывает (``no_scope``), а не идёт «от никого». Байты по A2A не идут:
в ответ агента — карточка артефакта (A2UI) или markdown-ссылка ``url``.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from ..als import current_bearer, current_turn_context

ArtifactPublishErrorCode = Literal[
    "no_scope",
    "invalid_input",
    "unauthorized",
    "not_found",
    "conflict",
    "too_large",
    "rate_limited",
    "storage_unavailable",
    "upstream_error",
    "network_error",
]

_STATUS_CODES: dict[int, ArtifactPublishErrorCode] = {
    400: "invalid_input",
    401: "unauthorized",
    403: "unauthorized",
    404: "not_found",
    409: "conflict",
    413: "too_large",
    429: "rate_limited",
    503: "storage_unavailable",
}

_SERVER_CODE_RE = re.compile(r"^[\w.:-]{1,64}$")


def artifact_error_code(status: int) -> ArtifactPublishErrorCode:
    """HTTP-статус ответа chat-backend → код ошибки SDK."""
    return _STATUS_CODES.get(status, "upstream_error")


class ArtifactPublishError(Exception):
    """Ошибка публикации. Текст несёт только код и статус: ни тела артефакта, ни ответа сервера."""

    def __init__(
        self,
        code: ArtifactPublishErrorCode,
        status: int | None = None,
        server_code: str | None = None,
    ) -> None:
        detail = ""
        if status:
            detail = f" (HTTP {status}{f' {server_code}' if server_code else ''})"
        super().__init__(f"publish_artifact: {code}{detail}")
        self.code = code
        self.status = status
        #: Короткий машинный код chat-backend (``thread_not_found``, ``invalid_kind``, …).
        self.server_code = server_code


@dataclass
class PublishArtifactFile:
    """Бинарное представление, когда формат уже не markdown (ZIP, исходная таблица)."""

    file_name: str
    data: bytes
    mime: str = "application/octet-stream"


@dataclass
class PublishedArtifact:
    """Что вернул chat-backend + готовые ``ref`` и ``url`` для ответа агента."""

    id: str
    kind: str
    name: str
    scope: str
    #: False — повтор: артефакт с тем же ключом и содержимым уже был опубликован.
    created: bool
    #: ``artifact:<id>`` или ``project-artifact:<id>`` — для ``context_refs``.
    ref: str
    #: Относительная ссылка в chat-backend (markdown-fallback вместо карточки).
    url: str
    raw: dict[str, Any] = field(default_factory=dict)


def _sha256(data: bytes | str) -> str:
    return hashlib.sha256(data.encode("utf-8") if isinstance(data, str) else data).hexdigest()


def default_idempotency_key(
    *,
    kind: str,
    name: str,
    markdown: str,
    files: list[PublishArtifactFile] | None,
    context_id: str,
    task_id: str | None,
) -> str:
    """Ключ по умолчанию — ход + содержимое (тот же алгоритм, что в TS-хосте).

    Тот же ход с тем же результатом даёт тот же ключ (ретрай не плодит дубль); другой результат в
    том же ходе — другой ключ.
    """
    parts = [
        context_id,
        task_id or "",
        kind,
        name,
        _sha256(markdown),
        *sorted(_sha256(f.data) for f in files or []),
    ]
    return f"auto:{_sha256(chr(10).join(parts))}"


def _form_fields(
    *,
    context_id: str,
    task_id: str | None,
    idempotency_key: str,
    kind: str,
    name: str,
    markdown: str,
    producer_agent_id: str,
    producer_skill_id: str | None,
    summary: str | None,
    supersedes_id: str | None,
    metadata: dict[str, Any] | None,
    project: bool,
) -> dict[str, str]:
    fields: dict[str, str | None] = {
        "contextId": context_id,
        "taskId": task_id,
        "idempotencyKey": idempotency_key,
        "kind": kind,
        "name": name,
        "markdown": markdown,
        "producerAgentId": producer_agent_id,
        "producerSkillId": producer_skill_id,
        "summary": summary,
        "supersedesId": supersedes_id,
        "metadata": json.dumps(metadata, ensure_ascii=False) if metadata else None,
        "project": "true" if project else None,
    }
    return {k: v for k, v in fields.items() if v is not None}


def _server_code(resp: httpx.Response) -> str | None:
    try:
        body = resp.json()
    except ValueError:
        return None
    code = body.get("error") if isinstance(body, dict) else None
    return code if isinstance(code, str) and _SERVER_CODE_RE.match(code) else None


MultipartPart = tuple[str, tuple[str | None, bytes, str]]


def _multipart(data: dict[str, str], files: list[PublishArtifactFile]) -> list[MultipartPart]:
    """Всё одним multipart: поля — части без имени файла, файлы — части ``files``.

    httpx без файлов отправил бы ``data`` как urlencoded, а chat-backend принимает multipart (или
    JSON). Часть с ``filename=None`` busboy читает как обычное поле, байты уходят как есть.
    """
    parts: list[MultipartPart] = [
        (k, (None, v.encode("utf-8"), "text/plain; charset=utf-8")) for k, v in data.items()
    ]
    parts.extend(("files", (f.file_name, f.data, f.mime)) for f in files)
    return parts


async def _post(
    url: str,
    *,
    parts: list[MultipartPart],
    token: str,
    timeout: float,
    http_client: httpx.AsyncClient | None,
) -> httpx.Response:
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    try:
        if http_client is not None:
            return await http_client.post(url, files=parts, headers=headers, timeout=timeout)
        async with httpx.AsyncClient() as client:
            return await client.post(url, files=parts, headers=headers, timeout=timeout)
    except httpx.HTTPError as exc:
        raise ArtifactPublishError("network_error") from exc


async def publish_artifact(
    *,
    base_url: str,
    kind: str,
    name: str,
    markdown: str,
    producer_agent_id: str,
    producer_skill_id: str | None = None,
    summary: str | None = None,
    files: list[PublishArtifactFile] | None = None,
    project: bool = False,
    supersedes_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
    context_id: str | None = None,
    task_id: str | None = None,
    bearer: Callable[[], str | None] | None = None,
    http_client: httpx.AsyncClient | None = None,
    timeout: float = 30.0,
) -> PublishedArtifact:
    """Публикует результат хода как артефакт (``POST {base_url}/api/artifacts``).

    ``context_id``/``task_id``/``bearer`` по умолчанию — из request-scope хода
    (:func:`current_turn_context`, :func:`current_bearer`). Без JWT или диалога —
    ``ArtifactPublishError('no_scope')`` без запроса.
    """
    turn = current_turn_context()
    token = (bearer or current_bearer)()
    ctx_id = context_id or (turn.context_id if turn else None)
    t_id = task_id or (turn.task_id if turn else None)
    if not token or not ctx_id:
        raise ArtifactPublishError("no_scope")

    key = idempotency_key or default_idempotency_key(
        kind=kind, name=name, markdown=markdown, files=files, context_id=ctx_id, task_id=t_id
    )
    data = _form_fields(
        context_id=ctx_id,
        task_id=t_id,
        idempotency_key=key,
        kind=kind,
        name=name,
        markdown=markdown,
        producer_agent_id=producer_agent_id,
        producer_skill_id=producer_skill_id,
        summary=summary,
        supersedes_id=supersedes_id,
        metadata=metadata,
        project=project,
    )
    resp = await _post(
        f"{base_url.rstrip('/')}/api/artifacts",
        parts=_multipart(data, files or []),
        token=token,
        timeout=timeout,
        http_client=http_client,
    )
    if resp.status_code >= 400:
        raise ArtifactPublishError(
            artifact_error_code(resp.status_code), resp.status_code, _server_code(resp)
        )
    return _published(resp)


def _published(resp: httpx.Response) -> PublishedArtifact:
    try:
        artifact = resp.json().get("artifact")
    except (ValueError, AttributeError):
        artifact = None
    if not isinstance(artifact, dict) or not artifact.get("id"):
        raise ArtifactPublishError("upstream_error", resp.status_code)
    scope = str(artifact.get("scope", "chat"))
    prefix = "project-artifact" if scope == "project" else "artifact"
    return PublishedArtifact(
        id=artifact["id"],
        kind=str(artifact.get("kind", "")),
        name=str(artifact.get("name", "")),
        scope=scope,
        created=resp.status_code == 201,
        ref=f"{prefix}:{artifact['id']}",
        url=f"/api/artifacts/{artifact['id']}",
        raw=artifact,
    )
