"""File-aware store-backends host'а (порт ``ts-host/src/store-backend``)."""

from .artifact_scope import ArtifactScope, artifact_scope
from .artifacts_store_backend import ArtifactsStoreBackend
from .attachment_contents import (
    AttachmentContent,
    AttachmentContentsResult,
    AttachmentReadFailure,
    extract_from_attachments,
    extraction_request,
    message_text,
    read_attachment_contents,
)
from .attachment_readers import (
    AttachmentGrepHit,
    AttachmentGrepResult,
    AttachmentReaders,
    WindowedRead,
    attachment_failure_reason,
    create_attachment_readers,
    read_store_within_budget,
)
from .attachments_store_backend import (
    AttachmentsStoreBackendBase,
    ChatAttachmentsStoreBackend,
    ProjectAttachmentsStoreBackend,
)
from .chat_store_backend import ChatStoreBackend
from .file_context import context_file_path, render_context_files_manifest
from .turn_files import (
    AttachmentFile,
    AttachmentTurnScope,
    attachment_scope,
    has_file_refs,
    project_id_from_refs,
)
from .types import (
    EditResult,
    FileInfo,
    GlobResult,
    GrepMatch,
    GrepResult,
    LsResult,
    ReadRawResult,
    ReadResult,
    StoreBackend,
    WriteResult,
)

__all__ = [
    "ArtifactScope",
    "artifact_scope",
    "AttachmentContent",
    "AttachmentContentsResult",
    "AttachmentReadFailure",
    "AttachmentGrepHit",
    "AttachmentGrepResult",
    "AttachmentReaders",
    "WindowedRead",
    "attachment_failure_reason",
    "create_attachment_readers",
    "read_store_within_budget",
    "read_attachment_contents",
    "extract_from_attachments",
    "extraction_request",
    "message_text",
    "AttachmentFile",
    "AttachmentTurnScope",
    "attachment_scope",
    "has_file_refs",
    "project_id_from_refs",
    "context_file_path",
    "render_context_files_manifest",
    "StoreBackend",
    "AttachmentsStoreBackendBase",
    "ChatAttachmentsStoreBackend",
    "ProjectAttachmentsStoreBackend",
    "ChatStoreBackend",
    "ArtifactsStoreBackend",
    "FileInfo",
    "GrepMatch",
    "LsResult",
    "GlobResult",
    "ReadResult",
    "ReadRawResult",
    "GrepResult",
    "WriteResult",
    "EditResult",
]
