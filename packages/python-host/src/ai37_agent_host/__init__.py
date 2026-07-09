"""ai37-agent-host (Python): A2A + AG-UI + MCP + file-aware store backends поверх a2a-sdk.

Порт ``@ai37/agent-host``. Публичный API расширяется по мере реализации модулей (Фаза 2).
"""

from .a2a_executor import HostExecutor
from .a2ui import A2uiMessage, component_to_a2ui_operations
from .agui import agui_routes
from .als import (
    HostLangfuseScope,
    HostScope,
    current_accepted_output_modes,
    current_bearer,
    current_ctx,
    current_langfuse_callbacks,
    current_langfuse_handler,
    current_langfuse_trace,
    current_scope,
    current_supported_catalog_ids,
    current_trace_id,
    reset_scope,
    scope_context,
    set_scope,
)
from .auth_guard import AuthGuardMiddleware
from .create_agent_host import create_agent_host
from .llm import (
    LITELLM_BASE_URL_ENV,
    LlmConfig,
    LlmConfigurationError,
    create_openai_client,
    resolve_llm_config,
)
from .output_modes import (
    A2UI_CAPABILITIES_VERSION,
    client_supports_catalog,
    filter_a2ui_by_catalog,
    filter_a2ui_components,
    negotiate_catalog,
    negotiate_catalogs,
    negotiate_output,
    negotiate_text,
    read_client_capabilities,
)
from .store_backend import (
    AttachmentsStoreBackendBase,
    ChatAttachmentsStoreBackend,
    ChatStoreBackend,
    ProjectAttachmentsStoreBackend,
    StoreBackend,
    context_file_path,
    render_context_files_manifest,
)
from .types import (
    A2uiAction,
    A2uiComponent,
    A2uiEvent,
    AgentChannel,
    AgentEvent,
    AgentHandler,
    AgentInput,
    AgentRequest,
    AgentResult,
    AgentStatus,
    Ai37Metadata,
    ContextFile,
    IntentEnvelope,
    NodeEvent,
    OutputNegotiation,
    ReasoningEvent,
    TextEvent,
    ToolEvent,
)

__all__ = [
    # types
    "AgentChannel",
    "OutputNegotiation",
    "IntentEnvelope",
    "ContextFile",
    "Ai37Metadata",
    "A2uiComponent",
    "AgentStatus",
    "A2uiAction",
    "AgentInput",
    "AgentEvent",
    "NodeEvent",
    "TextEvent",
    "A2uiEvent",
    "ReasoningEvent",
    "ToolEvent",
    "AgentResult",
    "AgentRequest",
    "AgentHandler",
    # als
    "HostScope",
    "HostLangfuseScope",
    "set_scope",
    "reset_scope",
    "scope_context",
    "current_scope",
    "current_ctx",
    "current_bearer",
    "current_accepted_output_modes",
    "current_supported_catalog_ids",
    "current_trace_id",
    "current_langfuse_trace",
    "current_langfuse_handler",
    "current_langfuse_callbacks",
    # output-modes (host negotiation)
    "A2UI_CAPABILITIES_VERSION",
    "negotiate_text",
    "negotiate_catalog",
    "negotiate_catalogs",
    "negotiate_output",
    "read_client_capabilities",
    "client_supports_catalog",
    "filter_a2ui_components",
    "filter_a2ui_by_catalog",
    # a2ui
    "A2uiMessage",
    "component_to_a2ui_operations",
    # llm (client from ctx.llm_key + LITELLM_BASE_URL)
    "LITELLM_BASE_URL_ENV",
    "LlmConfig",
    "LlmConfigurationError",
    "resolve_llm_config",
    "create_openai_client",
    # host app
    "create_agent_host",
    "HostExecutor",
    "AuthGuardMiddleware",
    # agui (AG-UI SSE adapter)
    "agui_routes",
    # store-backend (file-aware)
    "StoreBackend",
    "AttachmentsStoreBackendBase",
    "ChatAttachmentsStoreBackend",
    "ProjectAttachmentsStoreBackend",
    "ChatStoreBackend",
    "context_file_path",
    "render_context_files_manifest",
]
