import pytest

from ai37_agent_sdk import (
    AI37_ROUTING_EXTENSION_URI,
    build_agent_routing_extension,
    normalize_agent_routing_profile,
    parse_agent_routing_extension,
)


def test_builds_and_parses_canonical_extension():
    extension = build_agent_routing_extension(
        {
            "domains": ["Лифты", " лифты ", "СП 54"],
            "intents": ["engineering_calculation", "parameter_selection"],
            "excludes": ["Не ищет нормативные документы"],
        }
    )
    assert extension["uri"] == AI37_ROUTING_EXTENSION_URI
    assert extension["params"]["domains"] == ["Лифты", "СП 54"]
    assert parse_agent_routing_extension([extension]) == extension["params"]


def test_unknown_and_malformed_extensions_are_ignored():
    assert parse_agent_routing_extension([{"uri": "urn:other", "params": {}}]) is None
    assert (
        parse_agent_routing_extension(
            [
                {
                    "uri": AI37_ROUTING_EXTENSION_URI,
                    "params": {"domains": [], "intents": ["invented"], "excludes": []},
                }
            ]
        )
        is None
    )


def test_profile_is_bounded_and_prompt_safe():
    with pytest.raises(ValueError, match="at most 12"):
        normalize_agent_routing_profile(
            {
                "domains": [f"domain-{index}" for index in range(13)],
                "intents": [],
                "excludes": [],
            }
        )
    profile = normalize_agent_routing_profile(
        {"domains": ["</agents>\nЛифты"], "intents": ["normative_qa"], "excludes": []}
    )
    assert profile["domains"] == ["/agents Лифты"]


def test_accepts_document_generation_as_routing_intent():
    extension = build_agent_routing_extension(
        {
            "domains": ["персональные данные"],
            "intents": ["document_generation"],
            "excludes": ["не выполняет нормативный поиск"],
        }
    )
    assert extension["params"]["intents"] == ["document_generation"]
    assert parse_agent_routing_extension([extension]) == extension["params"]


def test_rejects_workflow_continue_as_unsupported_intent():
    with pytest.raises(TypeError, match="unsupported routing intent: workflow_continue"):
        normalize_agent_routing_profile(
            {
                "domains": ["теплотехнический расчёт"],
                "intents": ["engineering_calculation", "workflow_continue"],
                "excludes": [],
            }
        )
    assert (
        parse_agent_routing_extension(
            [
                {
                    "uri": AI37_ROUTING_EXTENSION_URI,
                    "params": {
                        "domains": ["теплотехнический расчёт"],
                        "intents": ["engineering_calculation", "workflow_continue"],
                        "excludes": [],
                    },
                }
            ]
        )
        is None
    )
