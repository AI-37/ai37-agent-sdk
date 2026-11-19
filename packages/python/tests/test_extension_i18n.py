"""Переводы showcase/v1 и routing/v1 (docs#589, срез 5).

Паритет с TS ``test/extension-i18n.test.ts``.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from ai37_agent_sdk import (
    AI37_ROUTING_EXTENSION_URI,
    build_agent_showcase_extension,
    localize_agent_routing_profile,
    localize_agent_showcase_profile,
    normalize_agent_routing_profile,
    normalize_agent_showcase_profile,
    parse_agent_routing_extension,
    parse_agent_showcase_extension,
)

#: Те же векторы читает TS-тест: переводы карточки оба SDK выбирают одинаково.
_VECTORS_PATH = Path(__file__).resolve().parents[3] / "contract" / "a2a-extension-i18n.vectors.json"
VECTORS = json.loads(_VECTORS_PATH.read_text("utf-8"))

SHOWCASE = normalize_agent_showcase_profile(VECTORS["showcaseLocalize"]["profile"])
ROUTING = normalize_agent_routing_profile(VECTORS["routingLocalize"]["profile"])


def _ids(cases: list[dict[str, Any]]) -> list[str]:
    return [case["name"] for case in cases]


@pytest.mark.parametrize(
    "case", VECTORS["showcaseNormalize"], ids=_ids(VECTORS["showcaseNormalize"])
)
def test_showcase_normalize_vectors(case: dict[str, Any]) -> None:
    assert normalize_agent_showcase_profile(case["input"]) == case["expected"]


@pytest.mark.parametrize(
    "case",
    VECTORS["showcaseLocalize"]["cases"],
    ids=_ids(VECTORS["showcaseLocalize"]["cases"]),
)
def test_showcase_localize_vectors(case: dict[str, Any]) -> None:
    assert localize_agent_showcase_profile(SHOWCASE, case["locale"]) == case["expected"]


def test_showcase_translations_survive_build_and_parse() -> None:
    parsed = parse_agent_showcase_extension([build_agent_showcase_extension(SHOWCASE)])
    assert parsed is not None
    assert parsed.get("i18n", {}).get("es-MX") == {"title": "Cálculo de elevadores"}
    assert parsed == SHOWCASE


def test_showcase_without_i18n_localizes_to_itself() -> None:
    plain = normalize_agent_showcase_profile({"title": "Поиск", "summary": "Поиск по документам"})
    assert localize_agent_showcase_profile(plain, "es") == plain


def test_showcase_localize_does_not_mutate_profile() -> None:
    before = copy.deepcopy(SHOWCASE)
    localize_agent_showcase_profile(SHOWCASE, "en")
    assert before == SHOWCASE


def test_showcase_base_stays_russian_for_old_consumers() -> None:
    assert SHOWCASE["title"] == "Расчёт лифтов"
    assert SHOWCASE.get("capabilities", [])[0]["title"] == "Жилые здания"


@pytest.mark.parametrize("case", VECTORS["routingNormalize"], ids=_ids(VECTORS["routingNormalize"]))
def test_routing_normalize_vectors(case: dict[str, Any]) -> None:
    assert normalize_agent_routing_profile(case["input"]) == case["expected"]


@pytest.mark.parametrize(
    "case",
    VECTORS["routingLocalize"]["cases"],
    ids=_ids(VECTORS["routingLocalize"]["cases"]),
)
def test_routing_localize_vectors(case: dict[str, Any]) -> None:
    assert localize_agent_routing_profile(ROUTING, case["locale"]) == case["expected"]


def test_routing_broken_translation_does_not_break_card_parsing() -> None:
    profile = parse_agent_routing_extension(
        [
            {
                "uri": AI37_ROUTING_EXTENSION_URI,
                "params": {
                    "domains": ["лифты"],
                    "intents": ["engineering_calculation"],
                    "excludes": [],
                    "i18n": {"es": {"excludes": [1, 2]}, "en": "broken"},
                },
            }
        ]
    )
    assert profile == {"domains": ["лифты"], "intents": ["engineering_calculation"], "excludes": []}


def test_routing_base_stays_strict() -> None:
    with pytest.raises(TypeError):
        normalize_agent_routing_profile(
            {
                "domains": [],
                "intents": [],
                "excludes": "not a list",
                "i18n": {"es": {"excludes": ["ok"]}},
            }
        )
