"""publish_artifact и ArtifactsStoreBackend через httpx.MockTransport (без сети)."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any
from urllib.parse import quote

import httpx
import pytest
from a2a.types import Message
from google.protobuf.json_format import ParseDict

from ai37_agent_host.a2a_executor import HostExecutor
from ai37_agent_host.als import HostScope, HostTurn, current_turn_context, scope_context
from ai37_agent_host.artifacts import (
    ArtifactPublishError,
    PublishArtifactFile,
    artifact_error_code,
    default_idempotency_key,
    publish_artifact,
)
from ai37_agent_host.store_backend import ArtifactsStoreBackend, context_file_path
from ai37_agent_host.types import AgentRequest, AgentResult

MARKDOWN = "# Протокол\n\nСекретная выкладка расчёта 42"
ARTIFACT = {
    "id": "a-1",
    "kind": "lift-report",
    "name": "Протокол",
    "summary": "Протокол",
    "scope": "chat",
    "contextId": "ctx-1",
    "isLarge": True,
    "createdAt": "2026-10-08",
    "files": [{"id": "f1", "fileName": "пакет.zip", "mime": "application/zip", "bytes": 3}],
}


def _client(handler: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _turn() -> Any:
    return scope_context(HostScope(bearer="user-jwt", turn=HostTurn("ctx-1", "task-1")))


def _form(req: httpx.Request) -> dict[str, Any]:
    """Разбирает multipart-тело запроса в {поле: значение} и список файлов."""
    ctype = req.headers["content-type"]
    assert ctype.startswith("multipart/form-data")
    boundary = ctype.split("boundary=")[1].encode()
    fields: dict[str, Any] = {"__files__": []}
    for part in req.content.split(b"--" + boundary):
        if b"Content-Disposition" not in part:
            continue
        head, _, body = part.partition(b"\r\n\r\n")
        body = body.rsplit(b"\r\n", 1)[0]
        name = head.split(b'name="')[1].split(b'"')[0].decode()
        if b"filename=" in head:
            filename = head.split(b'filename="')[1].split(b'"')[0].decode()
            fields["__files__"].append((name, filename, body))
        else:
            fields[name] = body.decode()
    return fields


# ── publish_artifact ───────────────────────────────────────────────────────────


async def test_no_scope_without_turn_and_no_request() -> None:
    calls: list[httpx.Request] = []

    with pytest.raises(ArtifactPublishError) as err:
        await publish_artifact(
            base_url="http://cb",
            kind="lift-report",
            name="n",
            markdown="m",
            producer_agent_id="a",
            http_client=_client(lambda r: calls.append(r) or httpx.Response(201)),
        )
    assert err.value.code == "no_scope"
    assert calls == []


@pytest.mark.parametrize(
    "scope",
    [HostScope(turn=HostTurn("ctx-1", "t")), HostScope(bearer="jwt")],
    ids=["нет JWT", "нет диалога"],
)
async def test_no_scope_partial(scope: HostScope) -> None:
    with scope_context(scope), pytest.raises(ArtifactPublishError) as err:
        await publish_artifact(
            base_url="http://cb", kind="k", name="n", markdown="m", producer_agent_id="a"
        )
    assert err.value.code == "no_scope"


async def test_publish_sends_multipart_from_turn_scope() -> None:
    seen: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["auth"] = req.headers["authorization"]
        seen["form"] = _form(req)
        return httpx.Response(201, json={"artifact": ARTIFACT})

    with _turn():
        res = await publish_artifact(
            base_url="http://cb/",
            kind="lift-report",
            name="Протокол",
            markdown=MARKDOWN,
            producer_agent_id="elevator-calc",
            metadata={"building": "А"},
            project=True,
            files=[PublishArtifactFile("пакет.zip", b"PK\x03", "application/zip")],
            http_client=_client(handler),
        )

    assert seen["url"] == "http://cb/api/artifacts"
    assert seen["auth"] == "Bearer user-jwt"
    form = seen["form"]
    assert form["contextId"] == "ctx-1"
    assert form["taskId"] == "task-1"
    # markdown уходит байт в байт — без CRLF-нормализации multipart.
    assert form["markdown"] == MARKDOWN
    assert json.loads(form["metadata"]) == {"building": "А"}
    assert form["project"] == "true"
    assert form["idempotencyKey"].startswith("auto:")
    assert "tenantId" not in form
    assert form["__files__"] == [("files", "пакет.zip", b"PK\x03")]
    assert (res.id, res.created, res.ref, res.url) == (
        "a-1",
        True,
        "artifact:a-1",
        "/api/artifacts/a-1",
    )


async def test_publish_without_files_is_still_multipart() -> None:
    seen: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["form"] = _form(req)
        return httpx.Response(200, json={"artifact": {**ARTIFACT, "scope": "project"}})

    with _turn():
        res = await publish_artifact(
            base_url="http://cb",
            kind="k",
            name="n",
            markdown="m",
            producer_agent_id="a",
            http_client=_client(handler),
        )
    assert seen["form"]["kind"] == "k"
    assert seen["form"]["__files__"] == []
    assert (res.created, res.ref) == (False, "project-artifact:a-1")


def test_default_key_matches_ts_host() -> None:
    # Тот же вектор, что в ts-host test/publish-artifact.test.ts: ключи совпадают между хостами.
    key = default_idempotency_key(
        kind="lift-report",
        name="Протокол",
        markdown="# Протокол\nрасчёт",
        files=[PublishArtifactFile("a", bytes([1, 2, 3]))],
        context_id="ctx-1",
        task_id="task-1",
    )
    assert key == "auto:45723bc590893178ca233071ad7901320089e89e122531c76c966cae000f4d00"
    assert (
        default_idempotency_key(
            kind="k", name="n", markdown="m", files=None, context_id="c", task_id=None
        )
        == "auto:9a4a12a8686e9e9528d2a83161b39ad53006d42243e6c576c5be920936033391"
    )


def test_default_key_sensitivity_and_file_order() -> None:
    base = dict(kind="k", name="n", markdown="m", context_id="c", task_id="t")
    a = PublishArtifactFile("a", b"1")
    b = PublishArtifactFile("b", b"2")
    key = default_idempotency_key(files=None, **base)  # type: ignore[arg-type]
    assert default_idempotency_key(files=None, **{**base, "markdown": "x"}) != key  # type: ignore[arg-type]
    assert default_idempotency_key(files=None, **{**base, "task_id": "t2"}) != key  # type: ignore[arg-type]
    assert default_idempotency_key(files=[a, b], **base) == default_idempotency_key(  # type: ignore[arg-type]
        files=[b, a],
        **base,  # type: ignore[arg-type]
    )


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (400, "invalid_input"),
        (401, "unauthorized"),
        (403, "unauthorized"),
        (404, "not_found"),
        (409, "conflict"),
        (413, "too_large"),
        (429, "rate_limited"),
        (503, "storage_unavailable"),
        (500, "upstream_error"),
    ],
)
async def test_error_normalization(status: int, code: str) -> None:
    assert artifact_error_code(status) == code
    with _turn(), pytest.raises(ArtifactPublishError) as err:
        await publish_artifact(
            base_url="http://cb",
            kind="k",
            name="n",
            markdown="m",
            producer_agent_id="a",
            http_client=_client(lambda r: httpx.Response(status, json={"error": "x_code"})),
        )
    assert (err.value.code, err.value.status, err.value.server_code) == (code, status, "x_code")


async def test_network_error() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    with _turn(), pytest.raises(ArtifactPublishError) as err:
        await publish_artifact(
            base_url="http://cb",
            kind="k",
            name="n",
            markdown="m",
            producer_agent_id="a",
            http_client=_client(handler),
        )
    assert err.value.code == "network_error"


async def test_error_text_has_no_body_and_no_jwt() -> None:
    with _turn(), pytest.raises(ArtifactPublishError) as err:
        await publish_artifact(
            base_url="http://cb",
            kind="k",
            name="n",
            markdown=MARKDOWN,
            producer_agent_id="a",
            http_client=_client(lambda r: httpx.Response(400, json={"error": f"boom {MARKDOWN}"})),
        )
    assert str(err.value) == "publish_artifact: invalid_input (HTTP 400)"
    assert err.value.server_code is None


async def test_upstream_without_artifact() -> None:
    with _turn(), pytest.raises(ArtifactPublishError) as err:
        await publish_artifact(
            base_url="http://cb",
            kind="k",
            name="n",
            markdown="m",
            producer_agent_id="a",
            http_client=_client(lambda r: httpx.Response(201, json={})),
        )
    assert err.value.code == "upstream_error"


# ── turn в request-scope ───────────────────────────────────────────────────────


async def test_executor_puts_turn_into_scope() -> None:
    seen: list[Any] = []

    class _Capture:
        async def run(self, req: AgentRequest) -> AgentResult:
            seen.append(current_turn_context())
            return AgentResult(status="completed", message="ok")

    class _Queue:
        async def enqueue_event(self, event: Any) -> None:
            return None

    rc = SimpleNamespace(
        message=ParseDict(
            {"role": "ROLE_USER", "parts": [{"text": "hi"}]}, Message(), ignore_unknown_fields=True
        ),
        task_id="t1",
        context_id="c1",
        configuration=None,
        current_task=None,
    )
    with scope_context(HostScope()):
        await HostExecutor(_Capture(), agent_text_modes=["text/plain"]).execute(rc, _Queue())
    assert seen == [HostTurn(context_id="c1", task_id="t1")]


def test_turn_outside_request_is_none() -> None:
    assert current_turn_context() is None


def test_context_file_path_maps_artifact_refs() -> None:
    assert context_file_path("artifact:a1") == "/artifacts/a1"
    assert context_file_path("project-artifact:a2") == "/project-artifacts/a2"


# ── ArtifactsStoreBackend ──────────────────────────────────────────────────────


def _server(req: httpx.Request) -> httpx.Response:
    assert req.headers["authorization"] == "Bearer tok"
    path = req.url.path
    if path == "/api/artifacts":
        if req.url.params.get("contextId") == "c1":
            return httpx.Response(200, json={"artifacts": [ARTIFACT]})
        return httpx.Response(404, json={"error": "project_not_found"})
    if path == "/api/artifacts/search":
        return httpx.Response(
            200, json={"matches": [{"id": "a-1", "name": "Протокол", "snippet": "лифтов\n 2"}]}
        )
    if path == "/api/artifacts/a-1/content":
        text = "строка2" if req.url.params.get("offset") == "1" else "# Протокол\nстрока2"
        return httpx.Response(200, json={"content": text})
    if path == "/api/artifacts/a-1":
        return httpx.Response(200, json={"artifact": ARTIFACT})
    if path == "/api/artifacts/a-1/files/f1":
        return httpx.Response(
            200,
            content=b"PK\x03",
            headers={
                "content-type": "application/zip",
                "content-disposition": "attachment; filename*=UTF-8''" + quote("пакет.zip"),
            },
        )
    return httpx.Response(404, json={"error": "not_found"})


def _backend(scope: Any) -> ArtifactsStoreBackend:
    return ArtifactsStoreBackend(
        base_url="http://cb/", scope=scope, bearer=lambda: "tok", http_client=_client(_server)
    )


async def test_backend_manifest_read_grep_glob() -> None:
    be = _backend(lambda: {"contextId": "c1"})

    ls = await be.ls("/")
    assert [f.path for f in ls.files or []] == ["/a-1"]
    manifest = await be.read("/")
    assert "**Протокол** (lift-report) — `/a-1`" in str(manifest.content)
    assert "файлы: пакет.zip" in str(manifest.content)
    assert (await be.read("/a-1", 1, 1)).content == "строка2"
    grep = await be.grep("лифт")
    assert grep.matches is not None
    assert (grep.matches[0].path, grep.matches[0].line, grep.matches[0].text) == (
        "/a-1",
        1,
        "[Протокол] лифтов 2",
    )
    assert len((await be.glob("*прото*")).files or []) == 1
    assert (await be.glob("*смета*")).files == []


async def test_backend_scope_missing_and_errors() -> None:
    be = _backend(lambda: None)
    assert "корпус" in str((await be.ls("/")).error)
    assert "корпус" in str((await be.grep("x")).error)
    assert "HTTP 404" in str((await _backend(lambda: {"projectId": "p"}).ls("/")).error)
    assert "HTTP 404" in str((await be.read("/zzz")).error)
    assert "Неизвестный путь" in str((await be.read("/a/b")).error)


async def test_backend_read_only_and_binary() -> None:
    be = _backend(lambda: {"contextId": "c1"})
    assert "неизменяемы" in str((await be.write("/x", "y")).error)
    assert "неизменяемы" in str((await be.edit("/x", "a", "b")).error)
    raw = await be.read_raw("/a-1/f1")
    assert (raw.content, raw.mime_type) == (b"PK\x03", "application/zip")
    assert "/<id>/<fileId>" in str((await be.read_raw("/a-1")).error)
    body = await be.read_file("a-1", "f1")
    assert body["file_name"] == "пакет.zip"
    assert (await be.meta("a-1"))["kind"] == "lift-report"
