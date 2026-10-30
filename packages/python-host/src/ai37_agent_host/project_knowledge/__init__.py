"""База проекта — порт ``ts-host/src/project-knowledge``: пул проекта document-service
(загрузка, поиск по названию), служебный токен ``client_credentials`` и мост chat-backend
«добавить в базу проекта»."""

from .bridge import (
    ProjectKnowledgeError,
    ProjectKnowledgeErrorCode,
    ProjectKnowledgeRefResult,
    ProjectKnowledgeResponse,
    ProjectKnowledgeStatus,
    index_to_project,
)
from .project_pool import (
    ProjectPoolDocument,
    ProjectPoolDuplicate,
    ProjectPoolError,
    ProjectPoolFile,
    ProjectPoolUploadResult,
    find_project_document_by_title,
    upload_to_project_pool,
)
from .service_tokens import ServiceTokenError, ServiceTokenErrorCode, service_token

__all__ = [
    "ProjectKnowledgeError",
    "ProjectKnowledgeErrorCode",
    "ProjectKnowledgeRefResult",
    "ProjectKnowledgeResponse",
    "ProjectKnowledgeStatus",
    "index_to_project",
    "ProjectPoolDocument",
    "ProjectPoolDuplicate",
    "ProjectPoolError",
    "ProjectPoolFile",
    "ProjectPoolUploadResult",
    "find_project_document_by_title",
    "upload_to_project_pool",
    "ServiceTokenError",
    "ServiceTokenErrorCode",
    "service_token",
]
