"""Тесты HTTP store-backend'ов вложений через httpx.MockTransport (без сети).

Бэкенды MOUNT-RELATIVE (контракт CompositeBackend): composite срезает префикс маунта на входе
и добавляет его к путям результатов на выходе. Бэкенд видит ``/`` и ``/<fileId>``; внешние пути
(``/chat-attachments/f1``) существуют только снаружи composite.
"""

import httpx

from ai37_agent_host.store_backend.attachments_store_backend import (
    ChatAttachmentsStoreBackend,
    ProjectAttachmentsStoreBackend,
)

_META = {
    "fileId": "f1",
    "sourceName": "list.xlsx",
    "bytes": 10,
    "sha256": "x",
    "summary": "ИНН список",
    "isLarge": False,
    "uploadedAt": "2026-07-09T00:00:00Z",
}


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _chat(handler, context_id="c1"):
    return ChatAttachmentsStoreBackend(
        base_url="http://cb",
        context_id=lambda: context_id,
        bearer=lambda: "tok",
        http_client=_client(handler),
    )


async def test_ls_and_manifest_read():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.headers["authorization"] == "Bearer tok"
        assert req.url.path == "/api/chat-attachments/"
        assert req.url.params["contextId"] == "c1"
        return httpx.Response(200, json={"attachments": [_META]})

    backend = _chat(handler)
    ls = await backend.ls("/")
    assert ls.error is None
    assert ls.files[0].path == "/f1"
    read = await backend.read("/")
    assert "list.xlsx" in read.content
    assert read.mime_type == "text/markdown"


async def test_read_content_window():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/chat-attachments/f1/content"
        assert req.url.params["offset"] == "0"
        assert req.url.params["limit"] == "100"
        return httpx.Response(200, json={"content": "markdown-window"})

    read = await _chat(handler).read("/f1", 0, 100)
    assert read.content == "markdown-window"


async def test_read_raw_returns_bytes():
    raw = b"PK\x03\x04-xlsx-bytes"

    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/chat-attachments/f1/raw"
        assert req.url.params["contextId"] == "c1"
        return httpx.Response(
            200, content=raw, headers={"content-type": "application/octet-stream"}
        )

    res = await _chat(handler).read_raw("/f1")
    assert res.error is None
    assert res.content == raw
    assert res.mime_type == "application/octet-stream"


async def test_scope_missing_without_context():
    backend = ChatAttachmentsStoreBackend(base_url="http://cb", context_id=lambda: None)
    ls = await backend.ls("/")
    assert ls.error is not None and "scope" in ls.error.lower()
    raw = await backend.read_raw("/f1")
    assert raw.error is not None


async def test_anchor_path_standalone_is_error():
    """BREAKING: якорная форма standalone не поддерживается — бэкенд не знает своего маунта."""
    backend = ChatAttachmentsStoreBackend(base_url="http://cb", context_id=lambda: "c1")
    read = await backend.read("/chat-attachments/f1")
    assert read.error is not None
    raw = await backend.read_raw("/chat-attachments/f1")
    assert raw.error is not None


async def test_grep_and_glob():
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("/search"):
            assert req.url.params["q"] == "лифт"
            return httpx.Response(
                200,
                json={
                    "matches": [
                        {
                            "fileId": "f1",
                            "sourceName": "list.xlsx",
                            "line": 3,
                            "snippet": "лифт  тут",
                        }
                    ]
                },
            )
        return httpx.Response(200, json={"attachments": [_META]})

    backend = _chat(handler)
    grep = await backend.grep("лифт", "/")
    assert grep.matches[0].path == "/f1"
    assert grep.matches[0].line == 3
    assert grep.matches[0].text == "[list.xlsx] лифт тут"
    glob = await backend.glob("*.xlsx")
    assert glob.files[0].path == "/f1"


async def test_write_edit_read_only():
    backend = ChatAttachmentsStoreBackend(base_url="http://cb", context_id=lambda: "c1")
    assert (await backend.write("/x", "y")).error is not None
    assert (await backend.edit("/x", "a", "b")).error is not None


async def test_project_read_raw_not_supported():
    backend = ProjectAttachmentsStoreBackend(base_url="http://cb", project_id=lambda: "p1")
    res = await backend.read_raw("/f1")
    assert res.error is not None
    assert res.content is None
