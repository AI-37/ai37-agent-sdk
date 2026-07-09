from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .auth.errors import AuthError
from .auth.headers import extract_bearer
from .auth.introspection import create_composite_verifier, looks_like_jwt
from .auth.types import Claims, JwtVerifier
from .auth.verifier import JwksJwtVerifier
from .billing.client import create_billing_client
from .billing.types import (
    BillingClient,
    BillingExecutionRequirement,
    BillingRuntimeState,
    BillingUsageEventInput,
)


@dataclass
class AuthSettings:
    issuer: str
    audience: str | list[str]
    jwks_url: str | None = None
    required: bool = True
    leeway: int | None = None
    # Долгоживущие opaque API-ключи: валидируются introspection-эндпоинтом billing-microservice.
    # Если задан вместе с jwks_url — собирается CompositeVerifier (JWT → JWKS, иначе → introspect).
    introspection_url: str | None = None
    introspection_token: str | None = None
    introspection_cache_ttl_ms: int | None = None


@dataclass
class BillingSettings:
    base_url: str
    apps_auth_token: str | None = None
    timeout_ms: int | None = None
    runtime_state_cache_ttl_ms: int | None = None


@dataclass
class AgentContextSettings:
    auth: AuthSettings
    billing: BillingSettings


class AgentContext:
    """Sugar для агентов: verify JWT → claims → billing client → preflight/usage.

    Синхронный (как и весь Python-SDK). Инъекция verifier/billing_client — шов для тестов.
    """

    def __init__(
        self,
        *,
        claims: Claims | None,
        raw_token: str | None,
        billing: BillingClient,
    ) -> None:
        self.claims = claims
        self.raw_token = raw_token
        self.billing = billing
        self._cached_state: BillingRuntimeState | None = None

    @classmethod
    def from_request(
        cls,
        headers: Any,
        settings: AgentContextSettings,
        *,
        verifier: JwtVerifier | None = None,
        billing_client: BillingClient | None = None,
    ) -> AgentContext:
        token = extract_bearer(headers)
        required = settings.auth.required

        active_verifier = verifier
        if active_verifier is None:
            jwt_verifier: JwtVerifier | None = None
            if settings.auth.jwks_url:
                jwt_verifier = JwksJwtVerifier(
                    issuer=settings.auth.issuer,
                    audience=settings.auth.audience,
                    jwks_url=settings.auth.jwks_url,
                    leeway=settings.auth.leeway if settings.auth.leeway is not None else 60,
                )
            if jwt_verifier is not None or settings.auth.introspection_url:
                active_verifier = create_composite_verifier(
                    jwt=jwt_verifier,
                    introspection_url=settings.auth.introspection_url,
                    introspection_token=settings.auth.introspection_token,
                    introspection_cache_ttl_ms=settings.auth.introspection_cache_ttl_ms,
                )

        claims: Claims | None = None
        if token:
            if active_verifier is None:
                raise AuthError(
                    "AgentContext: no JWT verifier configured (set auth.jwks_url or introspection)",
                    "config",
                )
            claims = active_verifier.verify(token)
        elif required:
            raise AuthError("AgentContext: missing bearer token")

        # /state форвардит user-JWT (anti-IDOR). Для opaque API-ключей (не-JWT) форвардим
        # apps-token: billing /state не принимает opaque-ключ, а billing_org_id берётся из
        # верифицированных claims.
        forward_token = (
            token
            if token and looks_like_jwt(token)
            else settings.billing.apps_auth_token
        )
        billing = billing_client or create_billing_client(
            base_url=settings.billing.base_url,
            auth_token=forward_token or "",
            usage_ingest_token=settings.billing.apps_auth_token or "",
            timeout_ms=settings.billing.timeout_ms or 5000,
            runtime_state_cache_ttl_ms=(
                settings.billing.runtime_state_cache_ttl_ms
                if settings.billing.runtime_state_cache_ttl_ms is not None
                else 5000
            ),
        )
        return cls(claims=claims, raw_token=token, billing=billing)

    @property
    def billing_org_id(self) -> str | None:
        return self.claims.get("billing_org_id") if self.claims else None

    @property
    def llm_key(self) -> str | None:
        """Ключ LLM-шлюза из последнего preflight (или None)."""
        return self._cached_state.llm_key if self._cached_state else None

    def _require_billing_org_id(self) -> str:
        value = self.billing_org_id
        if not value:
            raise AuthError(
                "AgentContext: billing_org_id отсутствует (claims не верифицированы?)",
                "missing_claim",
            )
        return value

    def assert_execution_allowed(
        self,
        requirement: BillingExecutionRequirement | None = None,
        *,
        feature: str | None = None,
        privilege: str | None = None,
    ) -> BillingRuntimeState:
        req = requirement
        if req is None and (feature is not None or privilege is not None):
            req = BillingExecutionRequirement(feature=feature, privilege=privilege)
        state = self.billing.assert_execution_allowed(self._require_billing_org_id(), req)
        self._cached_state = state
        return state

    def report_usage(
        self,
        *,
        transaction_id: str,
        code: str,
        properties: dict[str, Any] | None = None,
    ) -> None:
        state = self._cached_state or self.billing.get_runtime_state_by_billing_org_id(
            self._require_billing_org_id()
        )
        self.billing.send_usage_event(
            BillingUsageEventInput(
                transaction_id=transaction_id,
                billing_runtime_state=state,
                code=code,
                properties=properties,
            )
        )
