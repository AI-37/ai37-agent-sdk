"""Чтение файлов хода и извлечение — паритет с ``ts-host/test/attachments-*.test.ts``.

HTTP chat-backend подменяется httpx.MockTransport, LLM — объектом с ``chat.completions.create``.
"""

from types import SimpleNamespace

import httpx
import pytest

from ai37_agent_host import (
    attachment_failure_reason,
    attachment_scope,
    create_attachment_readers,
    extract_from_attachments,
    read_attachment_contents,
    read_store_within_budget,
)
from ai37_agent_host.store_backend import (
    AttachmentContent,
    extraction_request,
    message_text,
)
from ai37_agent_host.types import ContextFile


def _scope():
    return attachment_scope(
        "ctx1",
        ["chat-attachment:c1", "project:p1"],
        [
            ContextFile(ref="chat-attachment:c1", name="договор.docx", scope="chat"),
            ContextFile(ref="project-attachment:f9", name="план.pdf", scope="project"),
        ],
    )


def _readers(handler, scope=None):
    return create_attachment_readers(
        chat_backend_url="http://cb/",
        scope=scope or _scope(),
        bearer=lambda: "jwt-1",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def _lines_handler(lines: list[str], calls: list[httpx.Request] | None = None):
    def handler(req: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(req)
        offset = int(req.url.params.get("offset", 0))
        limit = int(req.url.params.get("limit", 10**9))
        return httpx.Response(200, json={"content": "\n".join(lines[offset : offset + limit])})

    return handler


async def test_read_refuses_file_outside_turn_without_network():
    calls: list[httpx.Request] = []
    readers = _readers(_lines_handler(["чужое"], calls))
    res = await readers.read("chat-attachment:other")
    assert res.error and "нет среди приложенных" in res.error
    assert calls == []


async def test_read_chat_window_with_context_and_explicit_bearer():
    calls: list[httpx.Request] = []
    readers = _readers(_lines_handler([f"l{i}" for i in range(30)], calls))
    res = await readers.read("chat-attachment:c1", 10, 5)
    assert res.content == "\n".join(f"l{i}" for i in range(10, 15))
    req = calls[0]
    assert req.url.path == "/api/chat-attachments/c1/content"
    assert req.headers["authorization"] == "Bearer jwt-1"
    assert dict(req.url.params) == {"contextId": "ctx1", "offset": "10", "limit": "5"}


async def test_grep_keeps_only_turn_files_and_collects_errors():
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/chat-attachments/search":
            return httpx.Response(
                200,
                json={
                    "matches": [
                        {
                            "fileId": "c1",
                            "sourceName": "договор.docx",
                            "line": 4,
                            "snippet": "срок",
                        },
                        {"fileId": "stale", "sourceName": "старое", "line": 1, "snippet": "срок"},
                    ]
                },
            )
        assert req.url.params["projectId"] == "p1"
        return httpx.Response(500)

    found = await _readers(handler).grep("срок")
    assert [(h.ref, h.name, h.line, h.text) for h in found.hits] == [
        ("chat-attachment:c1", "договор.docx", 4, "срок")
    ]
    assert len(found.errors) == 1


async def test_read_within_budget_joins_windows_and_truncates():
    lines = [f"l{i}" for i in range(450)]
    readers = _readers(_lines_handler(lines))
    full = await readers.read_within_budget("chat-attachment:c1", 1_000_000)
    assert (full.content, full.truncated) == ("\n".join(lines), False)
    cut = await readers.read_within_budget("chat-attachment:c1", 20)
    assert cut.truncated and len(cut.content) == 20


async def test_read_store_within_budget_reads_by_path_without_turn_scope():
    lines = [f"p{i}" for i in range(250)]
    calls: list[tuple[str, int | None, int | None]] = []

    class Backend:
        async def read(self, file_path, offset=None, limit=None):
            calls.append((file_path, offset, limit))
            return SimpleNamespace(content="\n".join(lines[offset : offset + limit]), error=None)

    res = await read_store_within_budget(Backend(), "/f9", 1_000_000)
    assert res.content == "\n".join(lines) and not res.truncated
    # На строку больше окна: по ней видно, что файл продолжается.
    assert calls == [("/f9", 0, 201), ("/f9", 200, 201)]


def test_failure_reason():
    assert attachment_failure_reason("chat-backend → HTTP 403") == "access_denied"
    assert attachment_failure_reason(RuntimeError("HTTP 404")) == "unavailable"
    assert attachment_failure_reason("ECONNRESET") == "reader_failed"


async def test_contents_share_budget_skip_empty_and_report_failures():
    scope = attachment_scope(
        "ctx1",
        ["chat-attachment:a", "chat-attachment:empty", "chat-attachment:gone", "chat-attachment:b"],
    )
    bodies = {"a": "x" * 30, "empty": "   ", "b": "y" * 30}

    def handler(req: httpx.Request) -> httpx.Response:
        file_id = req.url.path.split("/")[3]
        if file_id not in bodies:
            return httpx.Response(404)
        return httpx.Response(200, json={"content": bodies[file_id]})

    result = await read_attachment_contents(_readers(handler, scope), budget_chars=40)
    assert [(c.ref, len(c.content), c.truncated) for c in result.contents] == [
        ("chat-attachment:a", 30, False),
        ("chat-attachment:b", 10, True),
    ]
    assert [(f.ref, f.scope, f.reason) for f in result.failures] == [
        ("chat-attachment:gone", "chat", "unavailable")
    ]


class _FakeLlm:
    def __init__(self, *responses):
        self.calls: list[dict] = []
        self._responses = list(responses)
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs):
        self.calls.append(kwargs)
        item = self._responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _response(content: str | None, reasoning: str | None = None):
    message = SimpleNamespace(content=content, reasoning_content=reasoning)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


_CONTENTS = [
    AttachmentContent(ref="chat-attachment:a", name="тз.docx", content="200 мм", truncated=True)
]


async def test_extract_sends_prompt_files_and_ceiling():
    llm = _FakeLlm(_response("толщина: 200 мм"))
    text = await extract_from_attachments(
        system_prompt="Извлеки",
        query="посчитай",
        contents=_CONTENTS,
        model="m",
        max_tokens=4096,
        extra_body={"reasoning_effort": "low"},
        client=llm,
    )
    assert text == "толщина: 200 мм"
    call = llm.calls[0]
    assert call["max_tokens"] == 4096
    assert call["temperature"] == 0
    assert call["extra_body"] == {"reasoning_effort": "low"}
    assert call["messages"][0] == {"role": "system", "content": "Извлеки"}
    assert '<файл имя="тз.docx" обрезан="да">' in call["messages"][1]["content"]


async def test_extract_without_ceiling_and_no_data():
    llm = _FakeLlm(_response("Нет данных."), _response(""))
    kwargs = dict(system_prompt="s", query="q", contents=_CONTENTS, model="m", client=llm)
    assert await extract_from_attachments(**kwargs) is None
    assert await extract_from_attachments(**kwargs) is None
    assert "max_tokens" not in llm.calls[0]


async def test_extract_skips_model_without_files_and_raises_errors():
    llm = _FakeLlm(RuntimeError("429"))
    kwargs = dict(system_prompt="s", query="q", model="m", client=llm)
    assert await extract_from_attachments(contents=[], **kwargs) is None
    assert llm.calls == []
    with pytest.raises(RuntimeError, match="429"):
        await extract_from_attachments(contents=_CONTENTS, **kwargs)


def test_request_format_matches_ts_host_and_reasoning_fallback():
    whole = [AttachmentContent(ref="r", name="a.md", content="t", truncated=False)]
    assert extraction_request("q", whole) == (
        'Запрос пользователя: "q".\n\nСодержимое приложенных файлов:\n\n'
        '<файл имя="a.md">\nt\n</файл>'
    )
    assert message_text(_response("a")) == "a"
    assert message_text(_response("", "d")) == "d"
    assert message_text(SimpleNamespace(choices=[])) == ""


# ── чтение окнами в бюджет по контракту полки chat-backend ────────────────────────────────────


def _window_lines(markdown: str, offset: int | None, limit: int | None) -> str:
    """Копия chat-backend ``windowLines`` (src/attachments/attachments.types.ts): строки через \\n,
    без номеров и без признака конца; пустая строка на краю окна даёт \\n на краю."""
    if not offset and limit is None:
        return markdown
    lines = markdown.split("\n")
    start = max(0, offset or 0)
    end = len(lines) if limit is None else start + max(0, limit)
    return "\n".join(lines[start:end])


class _Shelf:
    """Полка-фейк: окна режет как chat-backend и записывает запросы."""

    def __init__(self, markdown: str | None = None, endless: bool = False) -> None:
        self.markdown = markdown or ""
        self.endless = endless
        self.calls: list[tuple[int | None, int | None]] = []

    async def read(self, file_path, offset=None, limit=None):
        self.calls.append((offset, limit))
        if self.endless:
            return SimpleNamespace(content="\n".join(["x"] * limit), error=None)
        return SimpleNamespace(content=_window_lines(self.markdown, offset, limit), error=None)


def _paragraphs(count: int) -> str:
    """Markdown из docx: абзацы через пустую строку, так что каждая вторая строка пустая."""
    return "\n".join(f"Абзац {i}: текст абзаца." if i % 2 == 0 else "" for i in range(count))


async def test_window_file_of_3001_lines_with_blank_every_other_line_is_read_whole():
    markdown = _paragraphs(3001)
    shelf = _Shelf(markdown)
    assert markdown.split("\n")[199] == ""
    res = await read_store_within_budget(shelf, "/f", 1_000_000)
    assert (res.content, res.truncated) == (markdown, False)
    assert len(shelf.calls) == 16


async def test_window_same_file_through_turn_readers_and_rest():
    markdown = _paragraphs(3001)

    def handler(req: httpx.Request) -> httpx.Response:
        offset = int(req.url.params["offset"])
        limit = int(req.url.params["limit"])
        return httpx.Response(200, json={"content": _window_lines(markdown, offset, limit)})

    res = await _readers(handler).read_within_budget("chat-attachment:c1", 1_000_000)
    assert (res.content, res.truncated) == (markdown, False)


async def test_window_blank_lines_at_window_joints_survive():
    lines = [f"l{i}" for i in range(450)]
    lines[199] = ""  # последняя строка первого окна
    lines[200] = ""  # первая строка второго
    lines[400] = ""  # первая строка третьего
    markdown = "\n".join(lines)
    res = await read_store_within_budget(_Shelf(markdown), "/f", 1_000_000)
    assert (res.content, res.truncated) == (markdown, False)


async def test_window_file_of_exactly_n_windows_and_trailing_newline():
    markdown = "\n".join(f"l{i}" for i in range(400))
    exact = _Shelf(markdown)
    res = await read_store_within_budget(exact, "/f", 1_000_000)
    assert (res.content, res.truncated) == (markdown, False)
    assert exact.calls == [(0, 201), (200, 201)]
    # 400 строк и \n в конце — это 401-я, пустая строка: она в третьем окне.
    res = await read_store_within_budget(_Shelf(markdown + "\n"), "/f", 1_000_000)
    assert (res.content, res.truncated) == (markdown + "\n", False)


async def test_window_empty_file():
    shelf = _Shelf("")
    res = await read_store_within_budget(shelf, "/f", 100)
    assert (res.content, res.truncated) == ("", False)
    assert len(shelf.calls) == 1


async def test_window_budget_below_file_cuts_exactly_at_budget():
    markdown = _paragraphs(3001)
    first_window = len("\n".join(markdown.split("\n")[:200]))
    for budget in (1, first_window, first_window + 1, 5_000):
        res = await read_store_within_budget(_Shelf(markdown), "/f", budget)
        assert (res.content, res.truncated) == (markdown[:budget], True)


async def test_window_budget_equal_to_file_is_not_truncated():
    markdown = _paragraphs(3001)
    res = await read_store_within_budget(_Shelf(markdown), "/f", len(markdown))
    assert (res.content, res.truncated) == (markdown, False)


async def test_window_hitting_max_windows_is_truncated():
    shelf = _Shelf(endless=True)
    res = await read_store_within_budget(shelf, "/f", 10**9)
    assert res.truncated
    assert len(shelf.calls) == 1000
    assert len(res.content.split("\n")) == 200_000
