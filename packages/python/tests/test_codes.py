import json
from pathlib import Path

import pytest

from ai37_agent_sdk import BillingFeatureCode, BillingPrivilegeCode

# Тот же контракт читает TS-тест: перечисления обоих SDK обязаны совпадать с ним.
_CONTRACT = json.loads(
    (Path(__file__).resolve().parents[3] / "contract" / "feature-codes.json").read_text(
        encoding="utf-8"
    )
)


def _pairs(items: list[dict[str, str]]) -> dict[str, str]:
    return {item["constant"]: item["code"] for item in items}


def test_feature_codes_mirror_contract():
    assert {m.name: m.value for m in BillingFeatureCode} == _pairs(_CONTRACT["features"])


def test_privilege_codes_mirror_contract():
    assert {m.name: m.value for m in BillingPrivilegeCode} == _pairs(_CONTRACT["privileges"])


@pytest.mark.parametrize("kind", ["features", "privileges"])
def test_codes_and_constants_are_unique(kind: str):
    items = _CONTRACT[kind]
    assert len({i["code"] for i in items}) == len(items)
    assert len({i["constant"] for i in items}) == len(items)


def test_polimetrika_data_agent_codes():
    assert BillingFeatureCode.PolimetrikaDataAgent == "polimetrika-data-agent"
    assert BillingPrivilegeCode.PolimetrikaDataAgentAllowed == "polimetrika-data-agent-allowed"
