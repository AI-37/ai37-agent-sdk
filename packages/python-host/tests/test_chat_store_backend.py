"""Тесты ChatStoreBackend (история чатов/проектов) через httpx.MockTransport."""

import httpx

from ai37_agent_host.store_backend.chat_store_backend import ChatStoreBackend

_PROJECT = {"id": "p-id", "slug": "elev", "title": "Лифты", "createdAt": "t", "updatedAt": "t"}
_THREAD = {
    "id": "t-id",
    "contextId": "ctx1",
    "slug": "raschet",
    "title": "Расчёт",
    "projectId": "p-id",
    "createdAt": "t",
    "updatedAt": "2026-07-09",
}
_MSG = [
    {"role": "user", "content": "привет", "a2uiArtifacts": None, "createdAt": "t"},
    {"role": "assistant", "content": "здравствуйте", "a2uiArtifacts": None, "createdAt": "t"},
]


def _backend(handler):
    return ChatStoreBackend(
        base_url="http://cb",
        bearer=lambda: "tok",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


async def test_ls_root_is_synthetic():
    # CompositeBackend срезает mount-префикс (/history/) → backend видит "/".
    backend = _backend(lambda req: httpx.Response(500))
    ls = await backend.ls("/")
    assert {f.path for f in ls.files} == {"/projects/", "/threads/"}


async def test_ls_projects():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.headers["authorization"] == "Bearer tok"
        assert req.url.path == "/api/projects/"
        return httpx.Response(200, json={"projects": [_PROJECT]})

    ls = await _backend(handler).ls("/history/projects/")
    assert ls.files[0].path == "/projects/elev/"
    assert ls.files[0].is_dir is True


async def test_read_project_thread_transcript():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/projects/elev/threads/raschet"
        return httpx.Response(200, json={"messages": _MSG})

    read = await _backend(handler).read("/history/projects/elev/threads/raschet")
    assert read.mime_type == "text/markdown"
    assert "**Пользователь:** привет" in read.content
    assert "**Ассистент:** здравствуйте" in read.content


async def test_read_thread_slice():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"thread": _THREAD, "messages": _MSG})

    read = await _backend(handler).read("/threads/raschet", 0, 1)
    assert read.content.count("\n") == 0  # только заголовок


async def test_glob_by_name():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.params["name"] == "лифт"
        assert req.url.params["projectId"] == "none"
        return httpx.Response(200, json={"threads": [_THREAD]})

    glob = await _backend(handler).glob("*лифт*", "/threads/")
    assert glob.files[0].path == "/threads/raschet"


async def test_grep_full_text():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.params["content"] == "расчёт"
        return httpx.Response(
            200,
            json={
                "matches": [
                    {
                        "contextId": "ctx1",
                        "threadSlug": "raschet",
                        "threadTitle": "Расчёт",
                        "projectSlug": None,
                        "snippet": "расчёт  лифта",
                    }
                ]
            },
        )

    grep = await _backend(handler).grep("расчёт", "/threads/")
    assert grep.matches[0].path == "/threads/raschet"
    assert grep.matches[0].text == "[Расчёт] расчёт лифта"


async def test_read_only_ops():
    backend = ChatStoreBackend(base_url="http://cb")
    assert (await backend.write("/x", "y")).error is not None
    assert (await backend.edit("/x", "a", "b")).error is not None
    assert (await backend.read_raw("/x")).error is not None
