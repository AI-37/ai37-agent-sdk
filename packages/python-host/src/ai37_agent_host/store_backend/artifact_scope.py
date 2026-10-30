"""Артефакты хода — порт ``ts-host/src/attachments/artifact-scope.ts``.

Свои артефакты треда и артефакты проекта. По ADR 13 оркестратор их в ход не кладёт; агент
монтирует корпус сам (план project-knowledge-bridge, срез 2). Список загружается один раз, а
читатели (:func:`create_attachment_readers` с ``artifacts=``) отдают только артефакты из него.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from .artifacts_store_backend import ArtifactsStoreBackend
from .attachments_store_backend import BearerFn
from .file_context import context_file_path
from .turn_files import AttachmentFile

_REF_PREFIX = {"chat": "artifact:", "project": "project-artifact:"}


@dataclass(frozen=True)
class ArtifactScope:
    context_id: str
    project_id: str | None = None
    #: Артефакты треда, затем проекта; у каждого ``kind="artifact"``.
    files: list[AttachmentFile] = field(default_factory=list)
    #: Ошибки загрузки списков (``chat-backend /api/artifacts -> HTTP 403``). Список, который не
    #: загрузился, просто пуст: читать из него нечего, а остальные файлы хода работают.
    errors: list[str] = field(default_factory=list)


async def artifact_scope(
    *,
    chat_backend_url: str,
    context_id: str,
    project_id: str | None = None,
    bearer: BearerFn | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> ArtifactScope:
    """Загружает артефакты треда (``artifact:<id>``) и проекта (``project-artifact:<id>``) через
    ``ArtifactsStoreBackend``. ``bearer`` по умолчанию — ``current_bearer`` из request-scope."""
    corpora: list[tuple[Literal["chat", "project"], dict[str, str]]] = [
        ("chat", {"contextId": context_id})
    ]
    if project_id:
        corpora.append(("project", {"projectId": project_id}))

    def backend(corpus: dict[str, str]) -> ArtifactsStoreBackend:
        return ArtifactsStoreBackend(
            base_url=chat_backend_url,
            scope=lambda: corpus,
            bearer=bearer,
            http_client=http_client,
        )

    lists = await asyncio.gather(*(backend(corpus).list_artifacts() for _, corpus in corpora))
    result = ArtifactScope(context_id=context_id, project_id=project_id)
    for (shelf, _), listed in zip(corpora, lists, strict=True):
        if "error" in listed:
            result.errors.append(str(listed["error"]))
            continue
        result.files.extend(_artifact_file(meta, shelf) for meta in listed["artifacts"])
    return result


def _artifact_file(meta: dict[str, Any], shelf: Literal["chat", "project"]) -> AttachmentFile:
    artifact_id = str(meta.get("id", ""))
    ref = f"{_REF_PREFIX[shelf]}{artifact_id}"
    return AttachmentFile(
        ref=ref,
        path=context_file_path(ref) or f"/{artifact_id}",
        name=str(meta.get("name") or ref),
        scope=shelf,
        summary=str(meta["summary"]) if meta.get("summary") else None,
        is_large=bool(meta.get("isLarge")),
        kind="artifact",
    )
