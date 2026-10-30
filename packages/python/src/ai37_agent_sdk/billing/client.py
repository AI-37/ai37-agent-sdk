from __future__ import annotations

import time
from typing import Any
from urllib.parse import quote

import httpx

from .access import has_required_access
from .errors import BillingExecutionDeniedError
from .http import ensure_ok, normalize_billing_base_url, validate_options
from .types import (
    BillingClient,
    BillingExecutionRequirement,
    BillingRuntimeState,
    BillingUsageEventInput,
)

# has_required_access переехал в .access (чтобы errors.py звал explain_denial без цикла);
# импорт выше держит его доступным и как billing.client.has_required_access (совместимость).
__all__ = ["HttpBillingClient", "create_billing_client", "has_required_access"]

# Маршруты state в billing: по аккаунту биллинга (агенты, из JWT) и по организации (сервисы, у
# которых есть только org_id). В тексте ошибки — то же имя id, что и в TS-клиенте.
_RUNTIME_STATE_ID_LABEL = {"by-billing-org": "billingOrgId", "by-org": "orgId"}


class HttpBillingClient:
    """Клиент billing-сервиса.

    Эндпоинты: GET .../api/v1/billing/customers/by-billing-org/{id}/state,
    GET .../api/v1/billing/customers/by-org/{org_id}/state, POST .../api/v1/events.
    runtime state кэшируется по маршруту и id (TTL).
    """

    def __init__(
        self,
        *,
        base_url: str,
        auth_token: str,
        usage_ingest_token: str,
        timeout_ms: int = 5000,
        runtime_state_cache_ttl_ms: int = 5000,
        http_client: httpx.Client | None = None,
    ) -> None:
        validate_options(
            base_url=base_url,
            auth_token=auth_token,
            usage_ingest_token=usage_ingest_token,
            runtime_state_cache_ttl_ms=runtime_state_cache_ttl_ms,
        )
        self._base = normalize_billing_base_url(base_url)
        self._token = auth_token
        # /events (usage-ingest) — под apps-token: этот эндпоинт user-JWT не принимает.
        self._usage_token = usage_ingest_token
        self._ttl = runtime_state_cache_ttl_ms / 1000
        self._client = http_client or httpx.Client(timeout=timeout_ms / 1000)
        self._cache: dict[str, tuple[float, BillingRuntimeState]] = {}

    def _auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    def _fetch_state(self, route: str, id_: str) -> BillingRuntimeState:
        encoded = quote(id_, safe="")
        url = f"{self._base}/api/v1/billing/customers/{route}/{encoded}/state"
        response = self._client.get(url, headers=self._auth_headers())
        label = _RUNTIME_STATE_ID_LABEL[route]
        ensure_ok(response, f"Billing state request failed for {label}={id_}")
        return BillingRuntimeState.from_api(response.json())

    def _cached_state(self, route: str, id_: str) -> BillingRuntimeState:
        # Ключ кэша — пара (маршрут, id): state по billing_org_id и по org_id не подменяют друг
        # друга, даже если строки id совпали.
        key = f"{route}:{id_}"
        if self._ttl > 0:
            hit = self._cache.get(key)
            if hit is not None and (time.monotonic() - hit[0]) < self._ttl:
                return hit[1]
        state = self._fetch_state(route, id_)
        if self._ttl > 0:
            self._cache[key] = (time.monotonic(), state)
        return state

    def get_runtime_state_by_billing_org_id(
        self, billing_org_id: str
    ) -> BillingRuntimeState:
        return self._cached_state("by-billing-org", billing_org_id)

    def get_runtime_state_by_org_id(self, org_id: str) -> BillingRuntimeState:
        """State продукта по организации: для сервисов, у которых есть только org_id.

        Продукт billing берёт из токена, аккаунт биллинга по организации находит сам.
        """
        return self._cached_state("by-org", org_id)

    def assert_execution_allowed(
        self,
        billing_org_id: str,
        requirement: BillingExecutionRequirement | None = None,
    ) -> BillingRuntimeState:
        state = self.get_runtime_state_by_billing_org_id(billing_org_id)
        if (
            state.entitlement_status != "active"
            or state.remaining_total_tokens <= 0
            or not has_required_access(state, requirement)
        ):
            raise BillingExecutionDeniedError(state, requirement)
        return state

    def send_usage_event(self, event: BillingUsageEventInput) -> None:
        payload = _build_usage_payload(event)
        response = self._client.post(
            f"{self._base}/api/v1/events",
            headers={
                "Authorization": f"Bearer {self._usage_token}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        ensure_ok(response, "Billing usage event rejected")


def create_billing_client(
    *,
    base_url: str,
    auth_token: str,
    usage_ingest_token: str,
    timeout_ms: int = 5000,
    runtime_state_cache_ttl_ms: int = 5000,
    http_client: httpx.Client | None = None,
) -> BillingClient:
    return HttpBillingClient(
        base_url=base_url,
        auth_token=auth_token,
        usage_ingest_token=usage_ingest_token,
        timeout_ms=timeout_ms,
        runtime_state_cache_ttl_ms=runtime_state_cache_ttl_ms,
        http_client=http_client,
    )


def _build_usage_payload(event: BillingUsageEventInput) -> dict[str, Any]:
    return {
        "event": {
            "transaction_id": event.transaction_id,
            "external_customer_id": event.billing_runtime_state.org_id,
            "code": event.code,
            "timestamp": event.timestamp if event.timestamp is not None else int(time.time()),
            "properties": event.properties or {},
        }
    }
