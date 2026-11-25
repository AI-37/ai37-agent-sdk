from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, cast

from ..auth.types import OrgRole

# Источник истины по форме — contract/billing-runtime-state.schema.json.
# Wire-формат billing-сервиса — camelCase; на стороне Python — snake_case (from_api маппит).

PrivilegeValue = object | None  # int | float | bool | str | None


@dataclass
class BillingRuntimePrivilege:
    code: str
    value_type: str  # integer | boolean | string | select
    config: dict[str, Any] = field(default_factory=dict)
    name: str | None = None
    value: PrivilegeValue = None


@dataclass
class BillingRuntimeFeature:
    code: str
    privileges: list[BillingRuntimePrivilege] = field(default_factory=list)
    name: str | None = None
    description: str | None = None


@dataclass
class BillingRuntimeSubject:
    """Кто спрашивает: роль и группы пользователя в этой организации.

    Billing кладёт блок в state, только когда запрос пришёл с ``?subject=<sub>``. Что из этого
    пускать — решает сам сервис.
    """

    user_uuid: str
    role: OrgRole | None = None  # None — пользователь не участник организации
    group_ids: list[str] = field(default_factory=list)
    member: bool = False  # False — не активный участник организации

    @classmethod
    def from_api(cls, data: dict[str, Any]) -> BillingRuntimeSubject:
        # В плане блок описан в snake_case, остальной state billing отдаёт в camelCase.
        # Принимаем оба написания: клиент не зависит от того, как сервер сериализует блок.
        group_ids = data.get("group_ids", data.get("groupIds"))
        return cls(
            user_uuid=str(data.get("user_uuid", data.get("userUuid")) or ""),
            role=cast("OrgRole | None", data.get("role")),
            group_ids=[str(g) for g in group_ids] if isinstance(group_ids, list) else [],
            member=data.get("member") is True,
        )


@dataclass
class BillingRuntimeState:
    org_id: str
    billing_org_id: str
    entitlement_status: str
    remaining_total_tokens: float
    features: list[BillingRuntimeFeature] = field(default_factory=list)
    stale: bool = False
    llm_key: str | None = None  # секрет — не логировать
    licensed_external_subscription_id: str | None = None
    metered_external_subscription_id: str | None = None
    current_plan_code: str | None = None
    current_subscription_status: str | None = None
    trial_ends_at: str | None = None
    snapshot_updated_at: str | None = None
    snapshot_version: float | None = None
    # Роль и группы пользователя; есть, только если state запрошен с subject=...
    subject: BillingRuntimeSubject | None = None

    @classmethod
    def from_api(cls, data: dict[str, Any]) -> BillingRuntimeState:
        features = [
            BillingRuntimeFeature(
                code=f["code"],
                name=f.get("name"),
                description=f.get("description"),
                privileges=[
                    BillingRuntimePrivilege(
                        code=p["code"],
                        value_type=p["valueType"],
                        config=p.get("config") or {},
                        name=p.get("name"),
                        value=p.get("value"),
                    )
                    for p in f.get("privileges", [])
                ],
            )
            for f in data.get("features", [])
        ]
        raw_subject = data.get("subject")
        return cls(
            org_id=data["orgId"],
            billing_org_id=data["billingOrgId"],
            entitlement_status=data["entitlementStatus"],
            remaining_total_tokens=data["remainingTotalTokens"],
            features=features,
            stale=bool(data.get("stale", False)),
            llm_key=data.get("llmKey"),
            licensed_external_subscription_id=data.get("licensedExternalSubscriptionId"),
            metered_external_subscription_id=data.get("meteredExternalSubscriptionId"),
            current_plan_code=data.get("currentPlanCode"),
            current_subscription_status=data.get("currentSubscriptionStatus"),
            trial_ends_at=data.get("trialEndsAt"),
            snapshot_updated_at=data.get("snapshotUpdatedAt"),
            snapshot_version=data.get("snapshotVersion"),
            subject=(
                BillingRuntimeSubject.from_api(raw_subject)
                if isinstance(raw_subject, dict)
                else None
            ),
        )


@dataclass
class BillingExecutionRequirement:
    feature: str | None = None  # BillingFeatureCode (str-enum) или str
    privilege: str | None = None  # BillingPrivilegeCode (str-enum) или str


@dataclass
class BillingUsageEventInput:
    transaction_id: str
    billing_runtime_state: BillingRuntimeState
    code: str
    timestamp: int | None = None
    properties: dict[str, Any] | None = None


class BillingClient(Protocol):
    # subject — sub пользователя: billing добавит в state блок subject с его ролью и группами,
    # кэш ведётся отдельно на каждого пользователя. Пустая строка — то же, что None.
    def get_runtime_state_by_billing_org_id(
        self, billing_org_id: str, *, subject: str | None = None
    ) -> BillingRuntimeState: ...

    def get_runtime_state_by_org_id(
        self, org_id: str, *, subject: str | None = None
    ) -> BillingRuntimeState: ...

    def assert_execution_allowed(
        self,
        billing_org_id: str,
        requirement: BillingExecutionRequirement | None = None,
        *,
        subject: str | None = None,
    ) -> BillingRuntimeState: ...

    def send_usage_event(self, event: BillingUsageEventInput) -> None: ...
