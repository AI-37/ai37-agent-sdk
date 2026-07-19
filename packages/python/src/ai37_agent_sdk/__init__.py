"""ai37-agent-sdk (Python): auth (JWKS) + billing + a2a forward + AgentContext.

API зеркалит TS-пакет @ai37/agent-sdk (имена snake_case, синхронный). Testing kit —
в подпакете ``ai37_agent_sdk.testing``.
"""

from .a2a import A2A_PROTOCOL_VERSION, build_a2a_auth_headers
from .auth import (
    AuthError,
    Claims,
    JwksJwtVerifier,
    JwtVerifier,
    OrgRole,
    create_jwt_verifier,
    extract_bearer,
)
from .billing import (
    BillingClient,
    BillingConfigurationError,
    BillingDenialReason,
    BillingExecutionDeniedError,
    BillingExecutionRequirement,
    BillingRequestError,
    BillingRuntimeFeature,
    BillingRuntimePrivilege,
    BillingRuntimeState,
    BillingUsageEventInput,
    create_billing_client,
    explain_denial,
    friendly_billing_message,
    has_required_access,
    normalize_billing_base_url,
)
from .codes import BillingFeatureCode, BillingPrivilegeCode
from .context import (
    AgentContext,
    AgentContextSettings,
    AuthSettings,
    BillingSettings,
)
from .output_modes import (
    OUTPUT_MODE_MARKDOWN,
    OUTPUT_MODE_MARKDOWN_SPAI,
    OUTPUT_MODE_TEXT,
    TEXT_OUTPUT_MODES,
    is_text_output_mode,
)

__all__ = [
    # auth
    "AuthError",
    "Claims",
    "OrgRole",
    "JwtVerifier",
    "JwksJwtVerifier",
    "create_jwt_verifier",
    "extract_bearer",
    # billing
    "BillingClient",
    "BillingConfigurationError",
    "BillingDenialReason",
    "BillingExecutionDeniedError",
    "BillingExecutionRequirement",
    "BillingRequestError",
    "BillingRuntimeFeature",
    "BillingRuntimePrivilege",
    "BillingRuntimeState",
    "BillingUsageEventInput",
    "create_billing_client",
    "explain_denial",
    "friendly_billing_message",
    "has_required_access",
    "normalize_billing_base_url",
    # a2a
    "A2A_PROTOCOL_VERSION",
    "build_a2a_auth_headers",
    # context
    "AgentContext",
    "AgentContextSettings",
    "AuthSettings",
    "BillingSettings",
    # codes
    "BillingFeatureCode",
    "BillingPrivilegeCode",
    # output-modes
    "OUTPUT_MODE_TEXT",
    "OUTPUT_MODE_MARKDOWN",
    "OUTPUT_MODE_MARKDOWN_SPAI",
    "TEXT_OUTPUT_MODES",
    "is_text_output_mode",
]
