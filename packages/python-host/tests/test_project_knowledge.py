"""База проекта: пул проекта DS, служебный токен, мост chat-backend — паритет с
``ts-host/test/project-knowledge.test.ts``. HTTP подменяется httpx.MockTransport; поток проверяется
и на настоящем HTTP-сервере."""

from __future__ import annotations

import io
import json
import threading
from collections.abc import AsyncIterator, Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote

import httpx
import pytest

from ai37_agent_host import (
    ProjectKnowledgeError,
    ProjectKnowledgeRefResult,
    ProjectPoolDuplicate,
    ProjectPoolError,
    ServiceTokenError,
    find_project_document_by_title,
    index_to_project,
    service_token,
    upload_to_project_pool,
)
from ai37_agent_host.als import HostScope, scope_context
from ai37_agent_host.project_knowledge import service_tokens

PDF = "%PDF-1.7 тело".encode()
KEY = "b1f0c2d4-0000-4000-8000-000000000001"
FILE_NAME = "Протокол расчёта (a1b2c3d4).pdf"

Reply = tuple[int, Any, dict[str, str]]


def _scripted(*replies: Reply) -> tuple[httpx.AsyncClient, list[httpx.Request], list[bytes]]:
    """Клиент, который отвечает по очереди заданными ответами и запоминает запросы и тела."""
    calls: list[httpx.Request] = []
    bodies: list[bytes] = []

    async def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        bodies.append(await req.aread())
        status, body, headers = replies[min(len(calls), len(replies)) - 1]
        return httpx.Response(status, json=body, headers=headers)

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), calls, bodies


def _reply(status: int, body: Any = None, headers: dict[str, str] | None = None) -> Reply:
    return (status, body, headers or {})


async def _upload(client: httpx.AsyncClient, **over: Any):
    kwargs: dict[str, Any] = {
        "document_service_url": "http://ds/",
        "project_key": KEY,
        "file": PDF,
        "file_name": FILE_NAME,
        "bearer": "jwt-user",
        "http_client": client,
    }
    kwargs.update(over)
    return await upload_to_project_pool(**kwargs)


# ── upload_to_project_pool ───────────────────────────────────────────────────────


async def test_upload_sends_body_with_ds_contract_headers():
    client, calls, bodies = _scripted(_reply(201, {"id": "series-1"}))
    res = await _upload(client, project_name="ЖК «Сосны»")
    assert res.series_id == "series-1" and res.duplicate_of is None
    req = calls[0]
    assert req.method == "POST"
    assert str(req.url) == f"http://ds/api/project-pools/{KEY}/documents"
    assert bodies[0] == PDF
    assert req.headers["authorization"] == "Bearer jwt-user"
    assert req.headers["content-type"] == "application/pdf"
    assert req.headers["content-length"] == str(len(PDF))
    assert req.headers["x-file-name"] == quote(FILE_NAME, safe="")
    assert unquote(req.headers["x-project-name"]) == "ЖК «Сосны»"


async def test_upload_without_project_name_and_non_pdf_as_octet_stream():
    client, calls, _ = _scripted(_reply(201, {"id": "s"}))
    await _upload(client, file_name="отчёт.docx")
    assert "x-project-name" not in calls[0].headers
    assert calls[0].headers["content-type"] == "application/octet-stream"


async def test_upload_streams_path_binary_file_and_async_iterable(tmp_path: Path):
    source = tmp_path / "отчёт.pdf"
    source.write_bytes(PDF)

    async def chunks() -> AsyncIterator[bytes]:
        yield PDF[:5]
        yield PDF[5:]

    client, calls, bodies = _scripted(_reply(201, {"id": "s"}))
    await _upload(client, file=source)
    await _upload(client, file=io.BytesIO(PDF))
    await _upload(client, file=chunks(), size=len(PDF))
    assert bodies == [PDF, PDF, PDF]
    for req in calls:
        assert req.headers["content-length"] == str(len(PDF))
        assert "transfer-encoding" not in req.headers


async def test_upload_async_iterable_requires_size():
    async def chunks() -> AsyncIterator[bytes]:
        yield PDF

    client, _, _ = _scripted(_reply(201, {"id": "s"}))
    with pytest.raises(ValueError, match="size"):
        await _upload(client, file=chunks())


@pytest.fixture
def live_server() -> Iterator[tuple[str, dict[str, Any]]]:
    received: dict[str, Any] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            received["headers"] = dict(self.headers)
            received["body"] = self.rfile.read(int(self.headers["Content-Length"]))
            payload = json.dumps({"id": "series-live"}).encode()
            self.send_response(201)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args: Any) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", received
    finally:
        server.shutdown()
        server.server_close()


async def test_real_http_receives_stream_with_content_length(
    tmp_path: Path, live_server: tuple[str, dict[str, Any]]
):
    url, received = live_server
    source = tmp_path / "отчёт.pdf"
    source.write_bytes(PDF)
    res = await upload_to_project_pool(
        document_service_url=url,
        project_key=KEY,
        file=source,
        file_name=FILE_NAME,
        bearer="jwt",
    )
    assert res.series_id == "series-live"
    assert received["headers"]["Content-Length"] == str(len(PDF))
    assert "Transfer-Encoding" not in received["headers"]
    assert unquote(received["headers"]["X-File-Name"]) == FILE_NAME
    assert received["body"] == PDF


async def test_upload_duplicate_is_result_not_error():
    client, _, _ = _scripted(
        _reply(
            409,
            {
                "code": "duplicate",
                "error": "Такой документ уже загружен",
                "duplicate": {"id": "old", "title": "Протокол"},
            },
        )
    )
    res = await _upload(client)
    assert res.series_id is None
    assert res.duplicate_of == ProjectPoolDuplicate(id="old", title="Протокол")


async def test_upload_busy_with_retry_after_header():
    client, _, _ = _scripted(
        _reply(503, {"code": "upload_busy", "retryAfterSeconds": 5}, {"Retry-After": "7"})
    )
    with pytest.raises(ProjectPoolError) as caught:
        await _upload(client)
    assert caught.value.code == "upload_busy"
    assert caught.value.status == 503
    assert caught.value.retry_after_seconds == 7


async def test_upload_busy_retry_after_from_body():
    client, _, _ = _scripted(_reply(503, {"code": "upload_busy", "retryAfterSeconds": 5}))
    with pytest.raises(ProjectPoolError) as caught:
        await _upload(client)
    assert caught.value.retry_after_seconds == 5


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (404, "pool_not_found"),
        (409, "ambiguous_project_pool"),
        (403, "documents_not_in_plan"),
        (409, "DOCUMENT_LIMIT_REACHED"),
    ],
)
async def test_upload_error_code_from_body_without_response_text(status: int, code: str):
    client, _, _ = _scripted(_reply(status, {"code": code, "error": "секретный текст ответа"}))
    with pytest.raises(ProjectPoolError) as caught:
        await _upload(client)
    assert (caught.value.code, caught.value.status) == (code, status)
    assert "секретный" not in str(caught.value)
    assert "Протокол" not in str(caught.value)


async def test_upload_without_code_and_network_failure():
    client, _, _ = _scripted(_reply(502))
    with pytest.raises(ProjectPoolError) as caught:
        await _upload(client)
    assert (caught.value.code, caught.value.status) == ("upstream_error", 502)

    def broken(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=req)

    with pytest.raises(ProjectPoolError) as caught:
        await _upload(httpx.AsyncClient(transport=httpx.MockTransport(broken)))
    assert caught.value.code == "network_error"


# ── find_project_document_by_title ───────────────────────────────────────────────


def _doc(doc_id: str, title: str) -> dict[str, Any]:
    return {
        "id": doc_id,
        "title": title,
        "state": "ready",
        "stage": "ready",
        "createdAt": "2026-10-30T00:00:00.000Z",
        "pageCount": 3,
        "readyPages": 3,
        "author": None,
    }


async def _find(client: httpx.AsyncClient, title: str):
    return await find_project_document_by_title(
        document_service_url="http://ds",
        project_key="p-1",
        title=title,
        bearer="jwt-user",
        http_client=client,
    )


async def test_find_picks_exact_title_from_substring_results():
    client, calls, _ = _scripted(
        _reply(
            200,
            {
                "documents": [
                    _doc("a", "Протокол расчёта (a1b2c3d4) — копия"),
                    _doc("b", "протокол расчёта (a1b2c3d4)"),
                    _doc("c", "Протокол расчёта (a1b2c3d4)"),
                ],
                "nextCursor": None,
            },
        )
    )
    found = await _find(client, " Протокол расчёта (a1b2c3d4) ")
    assert found is not None and found.id == "c" and found.state == "ready"
    req = calls[0]
    assert req.url.path == "/api/project-pools/p-1/documents"
    assert req.url.params["search"] == "Протокол расчёта (a1b2c3d4)"
    assert req.headers["authorization"] == "Bearer jwt-user"


async def test_find_returns_none_without_exact_match():
    client, _, _ = _scripted(
        _reply(200, {"documents": [_doc("a", "Протокол v2")], "nextCursor": None})
    )
    assert await _find(client, "Протокол") is None


async def test_find_follows_next_cursor():
    client, calls, _ = _scripted(
        _reply(200, {"documents": [_doc("a", "Отчёт 1")], "nextCursor": "cur-2"}),
        _reply(200, {"documents": [_doc("b", "Отчёт")], "nextCursor": None}),
    )
    found = await _find(client, "Отчёт")
    assert found is not None and found.id == "b"
    assert calls[1].url.params["cursor"] == "cur-2"


async def test_find_raises_ds_code():
    client, _, _ = _scripted(_reply(403, {"code": "documents_not_in_plan"}))
    with pytest.raises(ProjectPoolError) as caught:
        await _find(client, "Отчёт")
    assert (caught.value.code, caught.value.status) == ("documents_not_in_plan", 403)


# ── service_token ────────────────────────────────────────────────────────────────

DISCOVERY = _reply(200, {"token_endpoint": "https://auth/application/o/token/"})


async def _token(client: httpx.AsyncClient, name: str, secret: str = "secret") -> str:
    return await service_token(
        issuer=f"https://auth/application/o/{name}/",
        client_id=f"client-{name}",
        client_secret=secret,
        http_client=client,
    )


async def test_service_token_discovers_endpoint_and_uses_client_credentials():
    client, calls, bodies = _scripted(
        DISCOVERY, _reply(200, {"access_token": "svc-1", "expires_in": 300})
    )
    assert await _token(client, "discovery-test") == "svc-1"
    assert (
        str(calls[0].url)
        == "https://auth/application/o/discovery-test/.well-known/openid-configuration"
    )
    assert str(calls[1].url) == "https://auth/application/o/token/"
    assert calls[1].method == "POST"
    assert {k: v[0] for k, v in parse_qs(bodies[1].decode()).items()} == {
        "grant_type": "client_credentials",
        "client_id": "client-discovery-test",
        "client_secret": "secret",
    }


async def test_service_token_cached_until_expiry_then_refreshed(monkeypatch: pytest.MonkeyPatch):
    now = {"t": 1_000_000.0}
    monkeypatch.setattr(service_tokens, "_now", lambda: now["t"])
    client, calls, _ = _scripted(
        DISCOVERY,
        _reply(200, {"access_token": "svc-old", "expires_in": 300}),
        _reply(200, {"access_token": "svc-new", "expires_in": 300}),
    )
    assert await _token(client, "cache-test") == "svc-old"
    assert len(calls) == 2

    now["t"] += 239
    assert await _token(client, "cache-test") == "svc-old"
    assert len(calls) == 2

    # За минуту до истечения токен уже старый; discovery повторно не нужен.
    now["t"] += 2
    assert await _token(client, "cache-test") == "svc-new"
    assert len(calls) == 3


async def test_service_token_parallel_calls_share_one_request():
    import asyncio

    client, calls, _ = _scripted(
        DISCOVERY, _reply(200, {"access_token": "svc-shared", "expires_in": 300})
    )
    tokens = await asyncio.gather(*(_token(client, "parallel-test") for _ in range(3)))
    assert tokens == ["svc-shared"] * 3
    assert len(calls) == 2


async def test_service_token_rejected_without_secret_in_text():
    client, _, _ = _scripted(DISCOVERY, _reply(401, {"error": "invalid_client"}))
    with pytest.raises(ServiceTokenError) as caught:
        await _token(client, "rejected-test", secret="очень-секретно")
    assert (caught.value.code, caught.value.status) == ("token_rejected", 401)
    assert "очень-секретно" not in str(caught.value)


async def test_service_token_discovery_without_endpoint():
    client, _, _ = _scripted(_reply(200, {}))
    with pytest.raises(ServiceTokenError) as caught:
        await _token(client, "broken-discovery")
    assert caught.value.code == "discovery_failed"


# ── index_to_project ─────────────────────────────────────────────────────────────

RESULTS = [
    {"ref": "project-attachment:f1", "status": "sent", "seriesId": "series-1"},
    {"ref": "project-artifact:a1", "status": "already_indexed", "seriesId": "series-0"},
    {"ref": "project-attachment:f2", "status": "not_indexable", "reason": "raw_not_stored"},
    {"ref": "project-attachment:f3", "status": "busy", "retryAfterSeconds": 5},
    {"ref": "artifact:a2", "status": "rejected", "code": "ref_not_found"},
]


async def _index(client: httpx.AsyncClient, bearer: Callable[[], str | None] | None = None):
    return await index_to_project(
        chat_backend_url="http://cb/",
        project_id="p-1",
        refs=[row["ref"] for row in RESULTS],
        bearer=bearer,
        http_client=client,
    )


async def test_index_to_project_posts_refs_and_maps_results():
    client, calls, bodies = _scripted(_reply(200, {"projectId": "p-1", "results": RESULTS}))
    res = await _index(client, lambda: "jwt-user")
    assert res.project_id == "p-1"
    assert res.results == [
        ProjectKnowledgeRefResult(ref="project-attachment:f1", status="sent", series_id="series-1"),
        ProjectKnowledgeRefResult(
            ref="project-artifact:a1", status="already_indexed", series_id="series-0"
        ),
        ProjectKnowledgeRefResult(
            ref="project-attachment:f2", status="not_indexable", reason="raw_not_stored"
        ),
        ProjectKnowledgeRefResult(
            ref="project-attachment:f3", status="busy", retry_after_seconds=5.0
        ),
        ProjectKnowledgeRefResult(ref="artifact:a2", status="rejected", code="ref_not_found"),
    ]
    assert str(calls[0].url) == "http://cb/api/project-knowledge"
    assert calls[0].method == "POST"
    assert calls[0].headers["authorization"] == "Bearer jwt-user"
    assert json.loads(bodies[0]) == {"projectId": "p-1", "refs": [r["ref"] for r in RESULTS]}


async def test_index_to_project_takes_bearer_from_request_scope():
    client, calls, _ = _scripted(_reply(200, {"projectId": "p-1", "results": []}))
    with scope_context(HostScope(bearer="jwt-turn")):
        await _index(client)
    assert calls[0].headers["authorization"] == "Bearer jwt-turn"


async def test_index_to_project_without_jwt_is_no_scope_without_request():
    client, calls, _ = _scripted(_reply(200, {"results": []}))
    with pytest.raises(ProjectKnowledgeError) as caught:
        await _index(client)
    assert caught.value.code == "no_scope"
    assert calls == []


async def test_index_to_project_whole_request_refusal():
    client, _, _ = _scripted(_reply(403, {"error": "project_forbidden"}))
    with pytest.raises(ProjectKnowledgeError) as caught:
        await _index(client, lambda: "jwt")
    assert (caught.value.code, caught.value.status, caught.value.server_code) == (
        "unauthorized",
        403,
        "project_forbidden",
    )


async def test_index_to_project_malformed_and_missing_route():
    client, _, _ = _scripted(_reply(200, {"ok": True}))
    with pytest.raises(ProjectKnowledgeError) as caught:
        await _index(client, lambda: "jwt")
    assert caught.value.code == "upstream_error"
    client, _, _ = _scripted(_reply(404))
    with pytest.raises(ProjectKnowledgeError) as caught:
        await _index(client, lambda: "jwt")
    assert caught.value.code == "not_found"
