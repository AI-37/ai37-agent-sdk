from ai37_agent_host.store_backend.file_context import (
    context_file_path,
    render_context_files_manifest,
)
from ai37_agent_host.types import ContextFile


def test_context_file_path():
    assert context_file_path("chat-attachment:abc") == "/chat-attachments/abc"
    assert context_file_path("project-attachment:xyz") == "/project-attachments/xyz"
    assert context_file_path("http://foo") is None
    assert context_file_path("unknown:1") is None


def test_manifest_empty():
    assert render_context_files_manifest(None) == ""
    assert render_context_files_manifest([]) == ""


def test_manifest_render():
    files = [
        ContextFile(ref="chat-attachment:1", name="list.xlsx", scope="chat", summary="ИНН список"),
        ContextFile(ref="project-attachment:2", name="big.csv", scope="project", is_large=True),
    ]
    md = render_context_files_manifest(files)
    assert md.startswith("## Приложенные к диалогу файлы")
    assert "- **list.xlsx** — `/chat-attachments/1` — ИНН список" in md
    assert "- **big.csv** — `/project-attachments/2` _(большой" in md
