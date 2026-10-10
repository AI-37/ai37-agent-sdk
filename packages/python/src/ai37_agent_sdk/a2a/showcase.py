from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any, NotRequired, TypedDict, cast

from .text import compact_text

# Versioned identifier, not an endpoint. Consumers must not dereference it.
AI37_SHOWCASE_EXTENSION_URI = "https://schemas.ai37.ru/a2a/extensions/showcase/v1"


class AgentShowcaseNorm(TypedDict):
    """Норматив, по которому считает агент. `title` — полное наименование, печатается не везде:
    на компактных карточках остаётся только код. Пустой список значит, что агент на нормативы не
    ссылается, и поверхность ничего не печатает: выдуманная ссылка хуже отсутствующей, а
    «Норматив уточняется» у проверки контрагентов обещал бы то, чего никто не собирается делать."""

    code: str
    title: NotRequired[str]


class AgentShowcaseCapability(TypedDict):
    """Режим агента, который витрина рисует отдельной плиткой. Это подпись, а не скилл, на
    маршрутизацию она не влияет. Плитка может сослаться на скилл своей карточки (`skill`): тогда
    каталог показывает её только организациям, которые проходят гейт этого скилла
    (`x-ai37.skills[skill].billing`) в дополнение к гейту агента. Гейт живёт в одном месте, в
    биллинге карточки, плитка на него только ссылается. Порядок показа — порядок в массиве, поля
    `order` нет."""

    id: str
    title: str
    summary: str
    starter: NotRequired[str]
    examples: NotRequired[list[str]]
    # id скилла той же карточки. Нормализатор списка скиллов не видит и проверяет только форму:
    # есть ли такой скилл, решает каталог.
    skill: NotRequired[str]


class AgentShowcaseProfile(TypedDict):
    """Описание агента для витрины продукта: страница «Агенты» и пустой экран чата."""

    title: str
    summary: str
    computes: NotRequired[str]
    norms: NotRequired[list[AgentShowcaseNorm]]
    starter: NotRequired[str]
    examples: NotRequired[list[str]]
    order: NotRequired[int]
    capabilities: NotRequired[list[AgentShowcaseCapability]]


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
_CAPABILITIES_MAX_ITEMS = 6
# Тот же шаблон, что в TS. fullmatch, а не match с `$`: `$` в Python пропускает хвостовой `\n`.
_CAPABILITY_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
# id скилла — не slug: у Python-агентов `verify_single`, у TS-агентов `document-search`.
_SKILL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")


def _clamp(value: object, max_length: int) -> str:
    """В отличие от routing текст витрины обрезается, а не отвергается: выкинуть агента из
    каталога из-за 61-го символа дороже для пользователя, чем многоточие. Многоточие намеренное —
    обрезанная строка должна выглядеть обрезанной, а не настоящим названием.

    Длина считается в кодовых точках — `len()` в Python и так их считает, а в TS пришлось
    отказаться от `length` (там UTF-16 code units): иначе один и тот же заголовок с эмодзи в одном
    SDK обрезался бы, а в другом нет."""
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


def _capability(value: object) -> AgentShowcaseCapability | None:
    """Возможность без своей затравки и примеров валидна: плитка покажет только текст."""
    if not isinstance(value, Mapping):
        return None
    # id не чистим: пробелы по краям — уже не slug. Так TS и Python не расходятся в том, что
    # считать пробелом (`str.strip` и `String.prototype.trim` режут разные символы).
    raw_id = value.get("id")
    capability_id = raw_id if isinstance(raw_id, str) else ""
    title = _clamp(value.get("title"), _TITLE_MAX)
    summary = _clamp(value.get("summary"), _SUMMARY_MAX)
    if not _CAPABILITY_ID.fullmatch(capability_id) or not title or not summary:
        return None
    capability: AgentShowcaseCapability = {"id": capability_id, "title": title, "summary": summary}
    starter = _clamp(value.get("starter"), _STARTER_MAX)
    if starter:
        capability["starter"] = starter
    examples = _examples(value.get("examples"))
    if examples:
        capability["examples"] = examples
    # Кривая ссылка отбрасывается, плитка остаётся: показать её без гейта лучше, чем потерять, а
    # гейт агента всё равно действует. Не чистим по той же причине, что и id.
    skill = value.get("skill")
    if isinstance(skill, str) and _SKILL_ID.fullmatch(skill):
        capability["skill"] = skill
    return capability


def _capabilities(value: object) -> list[AgentShowcaseCapability]:
    """Битая возможность отбрасывается, профиль остаётся — так же, как с кривым нормативом: сам
    агент показать всё равно стоит. При повторе `id` остаётся первое вхождение."""
    if not isinstance(value, list):
        return []
    result: list[AgentShowcaseCapability] = []
    seen: set[str] = set()
    for item in value:
        if len(result) >= _CAPABILITIES_MAX_ITEMS:
            break
        capability = _capability(item)
        if capability is None or capability["id"] in seen:
            continue
        seen.add(capability["id"])
        result.append(capability)
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
    capabilities = _capabilities(profile.get("capabilities"))
    if capabilities:
        optional["capabilities"] = capabilities
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
