from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Literal, NotRequired, TypedDict, cast

from ..locale import canonical_locale_tag, locale_variant_chain
from .text import compact_text

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
    "document_generation",
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
        "document_generation",
    }
)


class AgentRoutingVariant(TypedDict, total=False):
    """Домены и исключения ещё на одном языке. Интенты — коды, их не переводят. В испанском запросе
    нет русской фразы-исключения, и без перевода guard молча перестаёт работать (docs#589 §3.5)."""

    domains: list[str]
    excludes: list[str]


class AgentRoutingProfile(TypedDict):
    """Базовые фразы — на русском: потребитель, который про ``i18n`` не знает, работает по ним, как
    раньше. ``i18n`` — тег BCP-47 → перевод; добавить его к базе —
    :func:`localize_agent_routing_profile`."""

    domains: list[str]
    intents: list[AgentRoutingIntent]
    excludes: list[str]
    i18n: NotRequired[dict[str, AgentRoutingVariant]]


class AgentRoutingExtension(TypedDict):
    uri: str
    description: str
    required: bool
    params: AgentRoutingProfile


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
        normalized = compact_text(item)
        if not normalized or len(normalized) > max_length:
            raise ValueError(f"routing.{field} items must be 1..{max_length} characters")
        key = normalized.casefold()
        if key not in seen:
            seen.add(key)
            result.append(normalized)
    return result


_DOMAINS_LIMITS = {"max_items": 12, "max_length": 80}
_EXCLUDES_LIMITS = {"max_items": 12, "max_length": 160}
_LOCALES_MAX = 16


def _variant_strings(value: object, field: str, limits: dict[str, int]) -> list[str]:
    """Кривой переведённый список отбрасывается сам по себе: маршрутизацию агенту он не ломает."""
    if value is None:
        return []
    try:
        return _strings(value, field, **limits)
    except (TypeError, ValueError):
        return []


def _variant(value: object) -> AgentRoutingVariant | None:
    if not isinstance(value, Mapping):
        return None
    variant: AgentRoutingVariant = {}
    domains = _variant_strings(value.get("domains"), "domains", _DOMAINS_LIMITS)
    if domains:
        variant["domains"] = domains
    excludes = _variant_strings(value.get("excludes"), "excludes", _EXCLUDES_LIMITS)
    if excludes:
        variant["excludes"] = excludes
    return variant or None


def _i18n(value: object) -> dict[str, AgentRoutingVariant]:
    """В отличие от базовых списков переводы нестрогие: поле необязательное и аддитивное, и битый
    перевод должен стоить только себя, а не всего профиля. Ключи — в каноническом регистре."""
    result: dict[str, AgentRoutingVariant] = {}
    if not isinstance(value, Mapping):
        return result
    for key, raw in value.items():
        if len(result) >= _LOCALES_MAX:
            break
        tag = canonical_locale_tag(key)
        variant = _variant(raw) if tag and tag not in result else None
        if tag and variant:
            result[tag] = variant
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
    profile: AgentRoutingProfile = {
        "domains": _strings(value.get("domains"), "domains", **_DOMAINS_LIMITS),
        "intents": intents,
        "excludes": _strings(value.get("excludes"), "excludes", **_EXCLUDES_LIMITS),
    }
    i18n = _i18n(value.get("i18n"))
    if i18n:
        profile["i18n"] = i18n
    return profile


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


def _merge_phrases(lists: list[list[str]]) -> list[str]:
    """Сначала база, потом переводы; фраза, повторённая в другом регистре, остаётся одна."""
    result: list[str] = []
    seen: set[str] = set()
    for phrase in (p for phrases in lists for p in phrases):
        if phrase.casefold() not in seen:
            seen.add(phrase.casefold())
            result.append(phrase)
    return result


def localize_agent_routing_profile(
    profile: AgentRoutingProfile, locale: str | None
) -> AgentRoutingProfile:
    """Профиль для хода на заданном языке: русская база плюс переводы по
    :func:`~ai37_agent_sdk.locale.locale_variant_chain` (``es-MX`` → ``es-MX`` и ``es``).

    База остаётся: пользователи смешивают языки, а промпт планировщика русский; перевод только
    добавляет фразы и никогда не убирает исключение. Язык без перевода получает базу как есть. В
    результате нет ``i18n``. Ждёт нормализованный профиль — ключи переводов в нём канонические.
    """
    i18n = profile.get("i18n") or {}
    variants = [i18n[tag] for tag in locale_variant_chain(locale) if tag in i18n]
    return {
        "domains": _merge_phrases([profile["domains"], *(v.get("domains", []) for v in variants)]),
        "intents": list(profile["intents"]),
        "excludes": _merge_phrases(
            [profile["excludes"], *(v.get("excludes", []) for v in variants)]
        ),
    }
