"""Артефакты хода — паритет с ``ts-host/test/attachments-artifacts.test.ts``.

HTTP chat-backend подменяется httpx.MockTransport.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx

from ai37_agent_host import (
    ArtifactScope,
    artifact_scope,
    attachment_scope,
    create_attachment_readers,
    read_attachment_contents,
)
from ai37_agent_host.store_backend import AttachmentFile
from ai37_agent_host.types import ContextFile

Route = Callable[[httpx.Request], Any]


def _client(route: Route, calls: list[httpx.Request]) -> httpx.AsyncClient:
    """Ответ по пути; None → 404."""

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        body = route(req)
        return httpx.Response(404, text="nope") if body is None else httpx.Response(200, json=body)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _meta(artifact_id: str, name: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": artifact_id,
        "kind": "lift-report",
        "name": name,
        "summary": "",
        "isLarge": False,
        "createdAt": "2026-10-30T00:00:00.000Z",
        "files": [],
        **extra,
    }


def _lists(req: httpx.Request) -> Any:
    """Манифесты корпусов: тред ctx1 и проект p1."""
    if req.url.path != "/api/artifacts":
        return None
    if req.url.params.get("contextId") == "ctx1":
        return {"artifacts": [_meta("a1", "Протокол расчёта лифтов", summary="ГОСТ 22845")]}
    if req.url.params.get("projectId") == "p1":
        return {"artifacts": [_meta("pa1", "Теплотехнический расчёт", isLarge=True)]}
    return None


TURN = attachment_scope(
    "ctx1",
    ["chat-attachment:c1", "project:p1"],
    [ContextFile(ref="chat-attachment:c1", name="договор.docx", scope="chat")],
)

#: Скоуп артефактов без сети: как его вернул бы artifact_scope.
ARTIFACTS = ArtifactScope(
    context_id="ctx1",
    project_id="p1",
    files=[
        AttachmentFile(
            ref="artifact:a1",
            path="/artifacts/a1",
            name="Протокол расчёта лифтов",
            scope="chat",
            kind="artifact",
        ),
        AttachmentFile(
            ref="project-artifact:pa1",
            path="/project-artifacts/pa1",
            name="Теплотехнический расчёт",
            scope="project",
            kind="artifact",
        ),
    ],
)


def _readers(route: Route, calls: list[httpx.Request]):
    return create_attachment_readers(
        chat_backend_url="http://cb",
        scope=TURN,
        artifacts=ARTIFACTS,
        bearer=lambda: "jwt-1",
        http_client=_client(route, calls),
    )


async def test_artifact_scope_loads_thread_and_project_with_explicit_bearer():
    calls: list[httpx.Request] = []
    scope = await artifact_scope(
        chat_backend_url="http://cb/",
        context_id="ctx1",
        project_id="p1",
        bearer=lambda: "jwt-1",
        http_client=_client(_lists, calls),
    )
    assert scope == ArtifactScope(
        context_id="ctx1",
        project_id="p1",
        files=[
            AttachmentFile(
                ref="artifact:a1",
                path="/artifacts/a1",
                name="Протокол расчёта лифтов",
                scope="chat",
                summary="ГОСТ 22845",
                kind="artifact",
            ),
            AttachmentFile(
                ref="project-artifact:pa1",
                path="/project-artifacts/pa1",
                name="Теплотехнический расчёт",
                scope="project",
                is_large=True,
                kind="artifact",
            ),
        ],
    )
    assert [req.headers["authorization"] for req in calls] == ["Bearer jwt-1"] * 2


async def test_artifact_scope_without_project_skips_project_list():
    calls: list[httpx.Request] = []
    scope = await artifact_scope(
        chat_backend_url="http://cb", context_id="ctx1", http_client=_client(_lists, calls)
    )
    assert [f.ref for f in scope.files] == ["artifact:a1"]
    assert len(calls) == 1


async def test_artifact_scope_failed_list_is_error_not_crash():
    calls: list[httpx.Request] = []
    scope = await artifact_scope(
        chat_backend_url="http://cb",
        context_id="ctx1",
        project_id="чужой",
        http_client=_client(_lists, calls),
    )
    assert [f.ref for f in scope.files] == ["artifact:a1"]
    assert scope.errors == ["chat-backend /api/artifacts -> HTTP 404"]


async def test_foreign_artifact_is_not_read_and_no_network():
    calls: list[httpx.Request] = []
    readers = _readers(lambda req: {"content": "чужое"}, calls)
    for ref in ("artifact:foreign", "project-artifact:foreign", "artifact:pa1"):
        res = await readers.read(ref)
        assert res.error and "нет среди приложенных" in res.error
    windowed = await readers.read_within_budget("project-artifact:a1", 100)
    assert windowed.error and "нет среди приложенных" in windowed.error
    assert calls == []


async def test_artifacts_added_to_turn_files():
    readers = _readers(lambda req: None, [])
    assert [f.ref for f in readers.scope.files] == [
        "chat-attachment:c1",
        "artifact:a1",
        "project-artifact:pa1",
    ]
    assert readers.file("artifact:a1").kind == "artifact"  # type: ignore[union-attr]
    assert readers.file("chat-attachment:c1").kind is None  # type: ignore[union-attr]


async def test_reads_own_artifact_window_by_id():
    calls: list[httpx.Request] = []
    readers = _readers(
        lambda req: (
            {"content": "# Расчёт"} if req.url.path == "/api/artifacts/pa1/content" else None
        ),
        calls,
    )
    res = await readers.read("project-artifact:pa1", 0, 50)
    assert res.content == "# Расчёт"
    assert calls[0].headers["authorization"] == "Bearer jwt-1"
    assert dict(calls[0].url.params) == {"offset": "0", "limit": "50"}


async def test_grep_searches_artifact_corpora_and_keeps_loaded_only():
    def route(req: httpx.Request) -> Any:
        if req.url.path == "/api/chat-attachments/search":
            return {"matches": []}
        if req.url.path != "/api/artifacts/search":
            return None
        if req.url.params.get("projectId") == "p1":
            return {
                "matches": [
                    {"id": "pa1", "kind": "teplo-report", "name": "Тепло", "snippet": "R = 3,2"}
                ]
            }
        return {
            "matches": [
                {"id": "a1", "kind": "lift-report", "name": "Протокол", "snippet": "лифт  на\n8"},
                {"id": "foreign", "kind": "lift-report", "name": "Чужой", "snippet": "лифт"},
            ]
        }

    calls: list[httpx.Request] = []
    found = await _readers(route, calls).grep("лифт")
    assert found.errors == []
    assert [(h.ref, h.name, h.line, h.text) for h in found.hits] == [
        ("artifact:a1", "Протокол расчёта лифтов", 1, "лифт на 8"),
        ("project-artifact:pa1", "Теплотехнический расчёт", 1, "R = 3,2"),
    ]
    searches = [dict(r.url.params) for r in calls if r.url.path == "/api/artifacts/search"]
    assert searches == [{"contextId": "ctx1", "q": "лифт"}, {"projectId": "p1", "q": "лифт"}]


async def test_read_attachment_contents_includes_artifacts():
    contents_by_path = {
        "/api/chat-attachments/c1/content": "договор",
        "/api/artifacts/a1/content": "протокол",
        "/api/artifacts/pa1/content": "",
    }

    def route(req: httpx.Request) -> Any:
        text = contents_by_path.get(req.url.path)
        return None if text is None else {"content": text}

    result = await read_attachment_contents(_readers(route, []))
    assert [(c.ref, c.content) for c in result.contents] == [
        ("chat-attachment:c1", "договор"),
        ("artifact:a1", "протокол"),
    ]
    assert result.failures == []
