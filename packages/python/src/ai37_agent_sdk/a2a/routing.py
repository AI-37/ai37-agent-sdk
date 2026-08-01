from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Literal, TypedDict, cast

# Versioned identifier, not an endpoint. Consumers must not dereference it.
AI37_ROUTING_EXTENSION_URI = "https://schemas.ai37.ru/a2a/extensions/routing/v1"

# Operation intents only. HITL/wizard continuation is orchestrator mode, not a card intent.
AgentRoutingIntent = Literal[
    "document_search",
    "document_list",
    "normative_qa",
    "exact_clause_lookup",
    "engineering_calculation",
    "parameter_selection",
    "counterparty_verification",
    "file_processing",
]

AI37_ROUTING_INTENTS: frozenset[str] = frozenset(
    {
        "document_search",
        "document_list",
        "normative_qa",
        "exact_clause_lookup",
        "engineering_calculation",
        "parameter_selection",
        "counterparty_verification",
        "file_processing",
    }
)


class AgentRoutingProfile(TypedDict):
    domains: list[str]
    intents: list[AgentRoutingIntent]
    excludes: list[str]


class AgentRoutingExtension(TypedDict):
    uri: str
    description: str
    required: bool
    params: AgentRoutingProfile


def _compact_text(value: str) -> str:
    safe = "".join(
        " " if ord(character) < 32 or ord(character) == 127 else character for character in value
    )
    return " ".join(safe.replace("<", " ").replace(">", " ").split())


def _strings(value: object, field: str, *, max_items: int, max_length: int) -> list[str]:
    if not isinstance(value, list):
        raise TypeError(f"routing.{field} must be an array")
    if len(value) > max_items:
        raise ValueError(f"routing.{field} must contain at most {max_items} items")
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            raise TypeError(f"routing.{field} items must be strings")
        normalized = _compact_text(item)
        if not normalized or len(normalized) > max_length:
            raise ValueError(f"routing.{field} items must be 1..{max_length} characters")
        key = normalized.casefold()
        if key not in seen:
            seen.add(key)
            result.append(normalized)
    return result


def normalize_agent_routing_profile(value: object) -> AgentRoutingProfile:
    if not isinstance(value, Mapping):
        raise TypeError("routing profile must be an object")
    raw_intents = value.get("intents")
    if not isinstance(raw_intents, list):
        raise TypeError("routing.intents must be an array")
    if len(raw_intents) > 16:
        raise ValueError("routing.intents must contain at most 16 items")
    intents: list[AgentRoutingIntent] = []
    for item in raw_intents:
        if not isinstance(item, str) or item not in AI37_ROUTING_INTENTS:
            raise TypeError(f"unsupported routing intent: {item}")
        intent = cast(AgentRoutingIntent, item)
        if intent not in intents:
            intents.append(intent)
    return {
        "domains": _strings(value.get("domains"), "domains", max_items=12, max_length=80),
        "intents": intents,
        "excludes": _strings(value.get("excludes"), "excludes", max_items=12, max_length=160),
    }


def build_agent_routing_extension(profile: AgentRoutingProfile) -> AgentRoutingExtension:
    return {
        "uri": AI37_ROUTING_EXTENSION_URI,
        "description": "Compact semantic routing profile for the AI37 agent registry.",
        "required": False,
        "params": normalize_agent_routing_profile(profile),
    }


def parse_agent_routing_extension(
    extensions: Iterable[object] | None,
) -> AgentRoutingProfile | None:
    for item in extensions or ():
        if not isinstance(item, Mapping) or item.get("uri") != AI37_ROUTING_EXTENSION_URI:
            continue
        try:
            return normalize_agent_routing_profile(cast(Mapping[str, Any], item).get("params"))
        except (TypeError, ValueError):
            return None
    return None
