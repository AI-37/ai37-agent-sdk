from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, NotRequired, TypedDict, cast

from .text import compact_text

# Versioned identifier, not an endpoint. Consumers must not dereference it.
AI37_SHOWCASE_EXTENSION_URI = "https://schemas.ai37.ru/a2a/extensions/showcase/v1"


class AgentShowcaseNorm(TypedDict):
    """Норматив, по которому считает агент. `title` — полное наименование, печатается не везде:
    на компактных карточках остаётся только код. Пустой список означает «Норматив уточняется» —
    выдуманная ссылка хуже отсутствующей."""

    code: str
    title: NotRequired[str]


class AgentShowcaseProfile(TypedDict):
    """Описание агента для витрины продукта: страница «Агенты» и пустой экран чата."""

    title: str
    summary: str
    computes: NotRequired[str]
    norms: NotRequired[list[AgentShowcaseNorm]]
    starter: NotRequired[str]
    examples: NotRequired[list[str]]
    order: NotRequired[int]


class AgentShowcaseExtension(TypedDict):
    uri: str
    description: str
    required: bool
    params: AgentShowcaseProfile


_TITLE_MAX = 60
_SUMMARY_MAX = 160
_COMPUTES_MAX = 240
_STARTER_MAX = 160
_NORMS_MAX_ITEMS = 4
_NORM_CODE_MAX = 80
_NORM_TITLE_MAX = 200
_EXAMPLES_MAX_ITEMS = 4
_EXAMPLE_MAX = 160


def _clamp(value: object, max_length: int) -> str:
    """В отличие от routing текст витрины обрезается, а не отвергается: выкинуть агента из
    каталога из-за 61-го символа дороже для пользователя, чем многоточие. Многоточие намеренное —
    обрезанная строка должна выглядеть обрезанной, а не настоящим названием."""
    if not isinstance(value, str):
        return ""
    text = compact_text(value)
    if len(text) <= max_length:
        return text
    return text[: max_length - 1].rstrip() + "…"


def _norms(value: object) -> list[AgentShowcaseNorm]:
    if not isinstance(value, list):
        return []
    result: list[AgentShowcaseNorm] = []
    seen: set[str] = set()
    for item in value:
        if len(result) >= _NORMS_MAX_ITEMS:
            break
        if not isinstance(item, Mapping):
            continue
        code = _clamp(item.get("code"), _NORM_CODE_MAX)
        if not code or code.casefold() in seen:
            continue
        seen.add(code.casefold())
        title = _clamp(item.get("title"), _NORM_TITLE_MAX)
        result.append({"code": code, "title": title} if title else {"code": code})
    return result


def _examples(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        if len(result) >= _EXAMPLES_MAX_ITEMS:
            break
        example = _clamp(item, _EXAMPLE_MAX)
        if not example or example.casefold() in seen:
            continue
        seen.add(example.casefold())
        result.append(example)
    return result


def _optional_fields(profile: Mapping[str, Any]) -> dict[str, Any]:
    """Пустые опциональные поля не выводим: карточка остаётся читаемой как JSON."""
    optional: dict[str, Any] = {}
    computes = _clamp(profile.get("computes"), _COMPUTES_MAX)
    if computes:
        optional["computes"] = computes
    norms = _norms(profile.get("norms"))
    if norms:
        optional["norms"] = norms
    starter = _clamp(profile.get("starter"), _STARTER_MAX)
    if starter:
        optional["starter"] = starter
    examples = _examples(profile.get("examples"))
    if examples:
        optional["examples"] = examples
    order = profile.get("order")
    if isinstance(order, int) and not isinstance(order, bool):
        optional["order"] = order
    return optional


def normalize_agent_showcase_profile(value: object) -> AgentShowcaseProfile:
    """Падает только когда показывать нечего: карточка, объявившая расширение без заголовка или
    краткого описания, в каталоге не нужна, и агент должен узнать об этом на своём CI. Остальное
    обрезается или отбрасывается."""
    if not isinstance(value, Mapping):
        raise TypeError("showcase profile must be an object")
    profile = cast(Mapping[str, Any], value)
    title = _clamp(profile.get("title"), _TITLE_MAX)
    summary = _clamp(profile.get("summary"), _SUMMARY_MAX)
    if not title or not summary:
        raise TypeError("showcase.title and showcase.summary are required")
    normalized = {"title": title, "summary": summary, **_optional_fields(profile)}
    return cast(AgentShowcaseProfile, normalized)


def build_agent_showcase_extension(profile: AgentShowcaseProfile) -> AgentShowcaseExtension:
    return {
        "uri": AI37_SHOWCASE_EXTENSION_URI,
        "description": "User-facing showcase profile for the AI37 agent catalog.",
        "required": False,
        "params": normalize_agent_showcase_profile(profile),
    }


def parse_agent_showcase_extension(
    extensions: Iterable[object] | None,
) -> AgentShowcaseProfile | None:
    for item in extensions or ():
        if not isinstance(item, Mapping) or item.get("uri") != AI37_SHOWCASE_EXTENSION_URI:
            continue
        try:
            return normalize_agent_showcase_profile(cast(Mapping[str, Any], item).get("params"))
        except (TypeError, ValueError):
            return None
    return None
