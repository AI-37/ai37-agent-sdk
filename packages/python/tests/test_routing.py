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


def test_profile_is_bounded():
    with pytest.raises(ValueError, match="at most 12"):
        normalize_agent_routing_profile(
            {
                "domains": [f"domain-{index}" for index in range(13)],
                "intents": [],
                "excludes": [],
            }
        )
