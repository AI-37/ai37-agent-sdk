from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace
from typing import Any

from ..auth.types import Claims
from ..billing.client import has_required_access
from ..billing.errors import BillingExecutionDeniedError
from ..billing.types import (
    BillingExecutionRequirement,
    BillingRuntimeState,
    BillingRuntimeSubject,
    BillingUsageEventInput,
)


class FakeJwtVerifier:
    """Возвращает заданные claims без проверки подписи (только для тестов)."""

    def __init__(self, claims: Claims) -> None:
        self._claims = claims

    def verify(self, token: str) -> Claims:  # noqa: ARG002 — токен игнорируется
        return self._claims


class InMemoryBillingClient:
    """In-memory billing-клиент: отдаёт фикстуру runtime state, пишет usage в ``sent_usage``.

    С ``subject=...`` к state добавляется блок ``subject`` из ``subjects`` (по ``user_uuid``),
    как это делает billing. Неизвестный пользователь получает ``member=False`` без групп.
    Без ``subject`` state отдаётся как есть.
    """

    def __init__(
        self,
        *,
        runtime_state: BillingRuntimeState,
        subjects: Iterable[BillingRuntimeSubject] = (),
    ) -> None:
        self._state = runtime_state
        self._subjects: dict[str, BillingRuntimeSubject] = {}
        for subject in subjects:
            self.set_subject(subject)
        self.sent_usage: list[dict[str, Any]] = []

    def set_runtime_state(self, state: BillingRuntimeState) -> None:
        self._state = state

    def set_subject(self, subject: BillingRuntimeSubject) -> None:
        """Задать (или заменить) роль и группы пользователя для запросов с ``subject``."""
        self._subjects[subject.user_uuid] = subject

    def get_runtime_state_by_billing_org_id(
        self,
        billing_org_id: str,  # noqa: ARG002
        *,
        subject: str | None = None,
    ) -> BillingRuntimeState:
        return self._state_for(subject)

    def get_runtime_state_by_org_id(
        self,
        org_id: str,  # noqa: ARG002
        *,
        subject: str | None = None,
    ) -> BillingRuntimeState:
        return self._state_for(subject)

    def assert_execution_allowed(
        self,
        billing_org_id: str,  # noqa: ARG002
        requirement: BillingExecutionRequirement | None = None,
        *,
        subject: str | None = None,
    ) -> BillingRuntimeState:
        s = self._state_for(subject)
        if (
            s.entitlement_status != "active"
            or s.remaining_total_tokens <= 0
            or not has_required_access(s, requirement)
        ):
            raise BillingExecutionDeniedError(s, requirement)
        return s

    def _state_for(self, subject: str | None) -> BillingRuntimeState:
        if not subject:
            return self._state
        block = self._subjects.get(subject) or BillingRuntimeSubject(user_uuid=subject)
        return replace(self._state, subject=block)

    def send_usage_event(self, event: BillingUsageEventInput) -> None:
        self.sent_usage.append(
            {
                "transaction_id": event.transaction_id,
                "code": event.code,
                "properties": event.properties or {},
            }
        )
