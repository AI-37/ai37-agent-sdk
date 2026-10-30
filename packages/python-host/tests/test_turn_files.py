from ai37_agent_host.store_backend import (
    AttachmentFile,
    attachment_scope,
    has_file_refs,
    project_id_from_refs,
)
from ai37_agent_host.types import ContextFile


def test_scope_merges_refs_and_manifest_without_duplicates():
    scope = attachment_scope(
        "ctx1",
        ["chat-attachment:c1", "project:p1", "chat-attachment:c1", "unknown:x"],
        [
            ContextFile(
                ref="chat-attachment:c1", name="договор.docx", scope="chat", summary="поставка"
            ),
            ContextFile(
                ref="project-attachment:f9", name="план.pdf", scope="project", is_large=True
            ),
        ],
    )
    assert scope.context_id == "ctx1"
    assert scope.project_id == "p1"
    assert scope.files == [
        AttachmentFile(
            ref="chat-attachment:c1",
            path="/chat-attachments/c1",
            name="договор.docx",
            scope="chat",
            summary="поставка",
        ),
        AttachmentFile(
            ref="project-attachment:f9",
            path="/project-attachments/f9",
            name="план.pdf",
            scope="project",
            is_large=True,
        ),
    ]


def test_scope_without_manifest_names_file_by_ref():
    scope = attachment_scope("c", ["chat-attachment:z"])
    assert scope.files == [
        AttachmentFile(
            ref="chat-attachment:z",
            path="/chat-attachments/z",
            name="chat-attachment:z",
            scope="chat",
        )
    ]
    assert scope.project_id is None


def test_empty_turn():
    assert attachment_scope("c").files == []


def test_refs_helpers():
    assert has_file_refs(["chat-attachment:a"])
    assert has_file_refs(["project-attachment:a"])
    assert has_file_refs(["project:p"])
    assert not has_file_refs(["thread:t"])
    assert project_id_from_refs(["x", "project:p7"]) == "p7"
    assert project_id_from_refs(["project:"]) is None
