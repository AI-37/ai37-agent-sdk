from __future__ import annotations

from enum import Enum
from typing import Literal

from .types import (
    BillingExecutionRequirement,
    BillingRuntimePrivilege,
    BillingRuntimeState,
)

# Конкретная причина отказа assert_execution_allowed — машиночитаемая, для логов и UI-маппинга.
BillingDenialReason = Literal[
    "ENTITLEMENT_INACTIVE",
    "NO_TOKENS",
    "MISSING_FEATURE",
    "MISSING_PRIVILEGE",
]


def _code_str(value: object) -> str:
    """Строковый код: .value у str-enum, иначе str (feature/privilege бывают и plain str)."""
    return value.value if isinstance(value, Enum) else str(value)


def is_privilege_accessible(privilege: BillingRuntimePrivilege) -> bool:
    if privilege.value_type == "boolean":
        return privilege.value is True
    if privilege.value_type == "integer":
        return isinstance(privilege.value, int | float) and not isinstance(privilege.value, bool)
    if privilege.value_type in ("string", "select"):
        return isinstance(privilege.value, str) and len(privilege.value) > 0
    return False


def has_required_access(
    state: BillingRuntimeState,
    requirement: BillingExecutionRequirement | None = None,
) -> bool:
    """Чистая проверка прав по runtime state (переиспользуется in-memory клиентом)."""
    if requirement is None or (requirement.feature is None and requirement.privilege is None):
        return True

    if requirement.feature is not None:
        matching = [f for f in state.features if f.code == requirement.feature]
    else:
        matching = list(state.features)

    if not matching:
        return False

    if requirement.privilege is None:
        return True

    return any(
        any(
            priv.code == requirement.privilege and is_privilege_accessible(priv)
            for priv in feature.privileges
        )
        for feature in matching
    )


def explain_denial(
    state: BillingRuntimeState,
    requirement: BillingExecutionRequirement | None = None,
) -> tuple[BillingDenialReason, str] | None:
    """Определяет КОНКРЕТНУЮ причину отказа (те же три условия, что assert_execution_allowed).

    Различает отсутствие фичи vs непредоставленную привилегию. None — отказа нет (доступ разрешён).
    """
    if state.entitlement_status != "active":
        return (
            "ENTITLEMENT_INACTIVE",
            f"entitlement_status={state.entitlement_status} "
            f"(plan={state.current_plan_code or '—'}, "
            f"subscription_status={state.current_subscription_status or '—'})",
        )

    if state.remaining_total_tokens <= 0:
        return ("NO_TOKENS", f"remaining_total_tokens={state.remaining_total_tokens}")

    # entitlement активен и токены есть → отказ может быть только по требуемому доступу.
    if (
        requirement is not None
        and requirement.feature is not None
        and not any(f.code == requirement.feature for f in state.features)
    ):
        granted = ", ".join(f.code for f in state.features)
        return (
            "MISSING_FEATURE",
            f"required feature={_code_str(requirement.feature)} not granted (granted: [{granted}])",
        )

    if not has_required_access(state, requirement):
        feat = _code_str(requirement.feature) if requirement and requirement.feature else "*"
        priv = _code_str(requirement.privilege) if requirement and requirement.privilege else "*"
        return (
            "MISSING_PRIVILEGE",
            f"feature={feat} present but privilege={priv} not granted or not accessible",
        )

    return None
