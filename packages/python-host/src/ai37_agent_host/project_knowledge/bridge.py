"""Мост «добавить в базу проекта» — порт ``ts-host/src/project-knowledge/index-to-project.ts``.

chat-backend (``POST /api/project-knowledge``, план project-knowledge-bridge, срез 3) отправляет
вложения и артефакты в пул проекта document-service. Мост без состояния; что уже лежит в пуле,
решают DS (sha256) и название артефакта. Формат ответа — тот же контракт, что у TS-хоста
(``ProjectKnowledgeResponse``).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from ..als import current_bearer

ProjectKnowledgeStatus = Literal["sent", "already_indexed", "not_indexable", "busy", "rejected"]

ProjectKnowledgeErrorCode = Literal[
    # Нет user-JWT: отправлять не от чьего имени.
    "no_scope",
    "invalid_input",
    "unauthorized",
    # Маршрута нет (chat-backend старее среза 3) или проект не найден.
    "not_found",
    "upstream_error",
    "network_error",
]

_STATUS_CODES: dict[int, ProjectKnowledgeErrorCode] = {
    400: "invalid_input",
    401: "unauthorized",
    403: "unauthorized",
    404: "not_found",
}

_SERVER_CODE_RE = re.compile(r"^[\w.:-]{1,64}$")


class ProjectKnowledgeError(Exception):
    """Отказ запроса целиком, в стиле ``ArtifactPublishError``: в тексте только код и статус.
    Отказы по отдельным ref приходят в результатах, а не ошибкой."""

    def __init__(
        self,
        code: ProjectKnowledgeErrorCode,
        status: int | None = None,
        server_code: str | None = None,
    ) -> None:
        detail = ""
        if status:
            detail = f" (HTTP {status}{f' {server_code}' if server_code else ''})"
        super().__init__(f"index_to_project: {code}{detail}")
        self.code = code
        self.status = status
        self.server_code = server_code


@dataclass(frozen=True)
class ProjectKnowledgeRefResult:
    """Результат по одному ref; заполнены поля своего статуса.

    * ``sent`` — ``series_id``: файл принят DS, распознавание идёт в фоне;
    * ``already_indexed`` — ``series_id`` документа, который уже в пуле;
    * ``not_indexable`` — ``reason`` (``raw_not_stored``, ``format_not_accepted``, …);
    * ``busy`` — ``retry_after_seconds``: DS занят приёмом других файлов;
    * ``rejected`` — ``code`` отказа (``access_grant``, ``project_private``, ``role_forbidden``,
      ``ref_not_found``, коды DS вроде ``documents_not_in_plan``).
    """

    ref: str
    status: ProjectKnowledgeStatus
    series_id: str | None = None
    reason: str | None = None
    retry_after_seconds: float | None = None
    code: str | None = None


@dataclass(frozen=True)
class ProjectKnowledgeResponse:
    """Ответ 200 моста: по результату на каждый ref запроса, в его порядке."""

    project_id: str
    results: list[ProjectKnowledgeRefResult] = field(default_factory=list)


async def index_to_project(
    *,
    chat_backend_url: str,
    project_id: str,
    refs: Sequence[str],
    bearer: Callable[[], str | None] | None = None,
    http_client: httpx.AsyncClient | None = None,
    timeout: float = 120.0,
) -> ProjectKnowledgeResponse:
    """Отправляет вложения и артефакты в базу проекта через мост chat-backend. Проверки доступа к
    проекту, приватности и роли делает chat-backend. ``bearer`` по умолчанию — ``current_bearer``
    из request-scope хода; без JWT — ``ProjectKnowledgeError('no_scope')`` без запроса."""
    token = (bearer or current_bearer)()
    if not token:
        raise ProjectKnowledgeError("no_scope")
    resp = await _post(
        f"{chat_backend_url.rstrip('/')}/api/project-knowledge",
        body={"projectId": project_id, "refs": list(refs)},
        token=token,
        timeout=timeout,
        http_client=http_client,
    )
    payload = _json(resp)
    if resp.status_code >= 400:
        raise ProjectKnowledgeError(
            _STATUS_CODES.get(resp.status_code, "upstream_error"),
            resp.status_code,
            _server_code(payload),
        )
    results = payload.get("results")
    if not isinstance(results, list):
        raise ProjectKnowledgeError("upstream_error", resp.status_code)
    return ProjectKnowledgeResponse(
        project_id=str(payload.get("projectId") or project_id),
        results=[_ref_result(row) for row in results if isinstance(row, dict)],
    )


async def _post(
    url: str,
    *,
    body: dict[str, Any],
    token: str,
    timeout: float,
    http_client: httpx.AsyncClient | None,
) -> httpx.Response:
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    try:
        if http_client is not None:
            return await http_client.post(url, json=body, headers=headers, timeout=timeout)
        async with httpx.AsyncClient() as client:
            return await client.post(url, json=body, headers=headers, timeout=timeout)
    except httpx.HTTPError as exc:
        raise ProjectKnowledgeError("network_error") from exc


def _ref_result(row: dict[str, Any]) -> ProjectKnowledgeRefResult:
    retry = row.get("retryAfterSeconds")
    return ProjectKnowledgeRefResult(
        ref=str(row.get("ref", "")),
        status=row.get("status", "rejected"),
        series_id=_text(row.get("seriesId")),
        reason=_text(row.get("reason")),
        retry_after_seconds=float(retry) if isinstance(retry, int | float) else None,
        code=_text(row.get("code")),
    )


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _json(resp: httpx.Response) -> dict[str, Any]:
    try:
        data = resp.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _server_code(payload: dict[str, Any]) -> str | None:
    """Только короткий машинный код: произвольный текст ответа в ошибку не тащим."""
    code = payload.get("error")
    return code if isinstance(code, str) and _SERVER_CODE_RE.match(code) else None
