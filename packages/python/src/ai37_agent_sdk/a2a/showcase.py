from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any, NotRequired, TypedDict, cast

from ..locale import canonical_locale_tag, locale_variant_chain
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


class AgentShowcaseCapabilityVariant(TypedDict):
    """Перевод плитки, сопоставляется базовой плитке по ``id``. Гейт (``skill``) не переводится:
    он живёт только на базовой плитке."""

    id: str
    title: NotRequired[str]
    summary: NotRequired[str]
    starter: NotRequired[str]
    examples: NotRequired[list[str]]


class AgentShowcaseVariant(TypedDict, total=False):
    """Витрина на одном языке. Все поля необязательны: недостающее берётся дальше по цепочке
    локали, а затем из русской базы. Нормативов здесь нет намеренно — норма цитируется на языке
    оригинала (docs#589 §1)."""

    title: str
    summary: str
    computes: str
    starter: str
    examples: list[str]
    capabilities: list[AgentShowcaseCapabilityVariant]


class AgentShowcaseProfile(TypedDict):
    """Описание агента для витрины продукта: страница «Агенты» и пустой экран чата.

    Базовые поля — на русском: потребитель, который про ``i18n`` не знает, показывает их, как
    раньше. ``i18n`` — тег BCP-47 (после нормализации в каноническом регистре) → перевод; выбрать
    вариант — :func:`localize_agent_showcase_profile`."""

    title: str
    summary: str
    computes: NotRequired[str]
    norms: NotRequired[list[AgentShowcaseNorm]]
    starter: NotRequired[str]
    examples: NotRequired[list[str]]
    order: NotRequired[int]
    capabilities: NotRequired[list[AgentShowcaseCapability]]
    i18n: NotRequired[dict[str, AgentShowcaseVariant]]


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
_LOCALES_MAX = 16
_VARIANT_TEXT_FIELDS = ("title", "summary", "computes", "starter", "examples")
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


def _variant_text(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Текстовые поля перевода и его плиток; пустые и отсутствующие не выводим."""
    text: dict[str, Any] = {}
    for field, max_length in (
        ("title", _TITLE_MAX),
        ("summary", _SUMMARY_MAX),
        ("starter", _STARTER_MAX),
    ):
        value = _clamp(raw.get(field), max_length)
        if value:
            text[field] = value
    examples = _examples(raw.get("examples"))
    if examples:
        text["examples"] = examples
    return text


def _capability_variants(
    value: object, base_ids: list[str]
) -> list[AgentShowcaseCapabilityVariant]:
    """Перевод плитки, которой нет в базе, отбрасывается: переводить нечего."""
    if not isinstance(value, list):
        return []
    result: list[AgentShowcaseCapabilityVariant] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        capability_id = item.get("id")
        if capability_id not in base_ids or any(c["id"] == capability_id for c in result):
            continue
        text = _variant_text(cast(Mapping[str, Any], item))
        if text:
            result.append(cast(AgentShowcaseCapabilityVariant, {"id": capability_id, **text}))
    return result


def _variant(value: object, base_ids: list[str]) -> AgentShowcaseVariant | None:
    if not isinstance(value, Mapping):
        return None
    raw = cast(Mapping[str, Any], value)
    variant = _variant_text(raw)
    computes = _clamp(raw.get("computes"), _COMPUTES_MAX)
    if computes:
        variant["computes"] = computes
    capabilities = _capability_variants(raw.get("capabilities"), base_ids)
    if capabilities:
        variant["capabilities"] = capabilities
    return cast(AgentShowcaseVariant, variant) if variant else None


def _i18n(value: object, base_ids: list[str]) -> dict[str, AgentShowcaseVariant]:
    """Переводы необязательны и аддитивны: ключ, который не тег BCP-47, и пустой перевод
    отбрасываются, базовый профиль остаётся. Ключи выходят в каноническом регистре."""
    result: dict[str, AgentShowcaseVariant] = {}
    if not isinstance(value, Mapping):
        return result
    for key, raw in value.items():
        if len(result) >= _LOCALES_MAX:
            break
        tag = canonical_locale_tag(key)
        variant = _variant(raw, base_ids) if tag and tag not in result else None
        if tag and variant:
            result[tag] = variant
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
    i18n = _i18n(profile.get("i18n"), [c["id"] for c in capabilities])
    if i18n:
        optional["i18n"] = i18n
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


def _overlay_text(base: Mapping[str, Any], variants: list[Mapping[str, Any]]) -> dict[str, Any]:
    result = dict(base)
    for field in _VARIANT_TEXT_FIELDS:
        value = next((v[field] for v in variants if field in v), None)
        if value is not None:
            result[field] = value
    return result


def _tile_variants(
    variants: list[AgentShowcaseVariant], capability_id: str
) -> list[Mapping[str, Any]]:
    return [
        cast(Mapping[str, Any], tile)
        for variant in variants
        for tile in variant.get("capabilities", [])
        if tile["id"] == capability_id
    ]


def localize_agent_showcase_profile(
    profile: AgentShowcaseProfile, locale: str | None
) -> AgentShowcaseProfile:
    """Витрина на языке пользователя.

    Каждое поле берётся из первого перевода по :func:`~ai37_agent_sdk.locale.locale_variant_chain`,
    где оно есть (``es-MX`` → ``es-MX``, затем ``es``), иначе из русской базы: язык без перевода
    (``pl`` или сам ``ru``) видит базу. Нормативы, порядок и гейты плиток всегда из базы. В
    результате нет ``i18n``: это то, что отдаёт каталог.

    Ждёт нормализованный профиль (из :func:`normalize_agent_showcase_profile` или
    :func:`parse_agent_showcase_extension`) — ключи переводов в нём уже канонические.
    """
    base = {key: value for key, value in profile.items() if key != "i18n"}
    i18n = profile.get("i18n") or {}
    variants = [i18n[tag] for tag in locale_variant_chain(locale) if tag in i18n]
    localized = _overlay_text(base, cast(list[Mapping[str, Any]], variants))
    if "capabilities" in profile:
        localized["capabilities"] = [
            _overlay_text(capability, _tile_variants(variants, capability["id"]))
            for capability in profile["capabilities"]
        ]
    return cast(AgentShowcaseProfile, localized)
