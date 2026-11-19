"""Локаль пользователя: список языков, цепочка фолбэков, разрешение локали хода.

Контракт — docs ``ecosystem/v2.4/06-i18n-locale.md`` (план docs#589, §3.1). Паритет с TS
``@ai37/agent-sdk`` (``src/locale.ts``): те же имена в snake_case и та же семантика.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, TypeVar

T = TypeVar("T")


@dataclass(frozen=True)
class SupportedLocale:
    """Запись списка поддерживаемых языков."""

    #: Тег BCP-47 (``язык[-регион][-вариант]``), канонический регистр.
    tag: str
    #: Название языка на нём самом — для переключателя языка и инструкции LLM.
    native_name: str
    #: Куда идти за строкой, если в словаре нет этого языка (задел: ``ca`` → ``es``).
    fallback: str | None = None


#: Поддерживаемые языки. Это данные, а не тип: новый язык добавляется строкой здесь и словарями,
#: без правки кода разрешения. ``es`` — европейский испанский, ``pt`` — бразильский португальский.
SUPPORTED_LOCALES: tuple[SupportedLocale, ...] = (
    SupportedLocale("ru", "Русский"),
    SupportedLocale("en", "English"),
    SupportedLocale("es", "Español"),
    SupportedLocale("de", "Deutsch"),
    SupportedLocale("fr", "Français"),
    SupportedLocale("pt", "Português"),
)

#: Конец любой цепочки фолбэков и язык для всего, чего нет в списке (решение В8).
FALLBACK_LOCALE = "en"

#: Локаль хода, когда её не передал ни конверт, ни токен. Русский — только обратная совместимость:
#: так клиенты, которые локаль ещё не шлют, получают прежнее поведение.
LEGACY_DEFAULT_LOCALE = "ru"

_LOCALE_TAG = re.compile(r"^[a-z]{2,3}(-[a-z0-9]{1,8})*$", re.IGNORECASE)
_REGION = re.compile(r"^([a-z]{2}|\d{3})$", re.IGNORECASE)


def _canonical_subtag(subtag: str, index: int) -> str:
    """Регистр подтега по BCP-47: язык строчными, письменность с заглавной, регион прописными."""
    if index == 0:
        return subtag.lower()
    if len(subtag) == 4 and subtag.isalpha():
        return subtag.capitalize()
    if _REGION.match(subtag):
        return subtag.upper()
    return subtag.lower()


def canonical_locale_tag(value: object) -> str | None:
    """Тег BCP-47 в каноническом регистре (``ES-mx`` → ``es-MX``, ``_`` → ``-``) или ``None``.

    Тег не обрезается: ``ca-ES-valencia`` остаётся целиком.
    """
    if not isinstance(value, str):
        return None
    raw = value.strip().replace("_", "-")
    if not _LOCALE_TAG.match(raw):
        return None
    return "-".join(_canonical_subtag(s, i) for i, s in enumerate(raw.split("-")))


def _find_supported(tag: str) -> SupportedLocale | None:
    return next((s for s in SUPPORTED_LOCALES if s.tag.lower() == tag.lower()), None)


def _tag_prefixes(tag: str) -> list[str]:
    """``ca-ES-valencia`` → ``['ca-ES-valencia', 'ca-ES', 'ca']``."""
    parts = tag.split("-")
    return ["-".join(parts[: len(parts) - i]) for i in range(len(parts))]


def _declared_fallback(tags: list[str]) -> str | None:
    for tag in tags:
        supported = _find_supported(tag)
        if supported and supported.fallback:
            return canonical_locale_tag(supported.fallback)
    return None


def locale_variant_chain(locale: str | None) -> list[str]:
    """Цепочка вариантов, которые локаль объявляет сама: точный тег → без варианта и региона →
    ``fallback``.

    Без ``en`` в конце: им кончается :func:`locale_chain`, а у переведённых вариантов карточки
    запасной вариант свой — русская база. Невалидная или пустая локаль → ``[]``.
    """
    chain: list[str] = []
    nxt = canonical_locale_tag(locale)
    while nxt and nxt not in chain:
        prefixes = [p for p in _tag_prefixes(nxt) if p not in chain]
        chain.extend(prefixes)
        nxt = _declared_fallback(prefixes)
    return chain


def locale_chain(locale: str | None) -> list[str]:
    """Цепочка поиска строки: точный тег → без варианта и региона → ``fallback`` → ``en``.

    Невалидная или пустая локаль → ``['en']``.
    """
    chain = locale_variant_chain(locale)
    if FALLBACK_LOCALE not in chain:
        chain.append(FALLBACK_LOCALE)
    return chain


def pick_locale_variant(variants: Mapping[str, T] | None, locale: str | None) -> T | None:
    """Вариант для локали из словаря ``тег → вариант`` по :func:`locale_variant_chain`.

    ``es-MX`` найдёт ``es``. Ничего не нашлось — ``None``, и вызывающий берёт свою базу: у карточек
    агентов это русские поля, поэтому язык вне словаря (``pl``) видит русский текст, а не
    английский. Ключи словаря сравниваются по каноническому тегу.
    """
    by_tag: dict[str, T] = {}
    for key, value in (variants or {}).items():
        tag = canonical_locale_tag(key)
        if tag and tag not in by_tag and value is not None:
            by_tag[tag] = value
    return next((by_tag[tag] for tag in locale_variant_chain(locale) if tag in by_tag), None)


def normalize_locale(locale: str | None) -> str:
    """Поддерживаемая локаль для значения из браузера, профиля или конверта (решение В8).

    Первый тег цепочки из ``SUPPORTED_LOCALES``; всё вне списка и пустое — ``en``. Тег из списка
    возвращается как есть, без обрезки до языка.
    """
    for tag in locale_chain(locale):
        supported = _find_supported(tag)
        if supported:
            return supported.tag
    return FALLBACK_LOCALE


def _explicit_locale(value: object) -> str | None:
    # ``auto`` в профиле значит «как в браузере»: это не язык, а его отсутствие.
    if isinstance(value, str) and value.strip().lower() == "auto":
        return None
    return canonical_locale_tag(value)


def resolve_request_locale(metadata_locale: object, claims: object = None) -> str:
    """Локаль хода: ``metadata.ai37.locale`` → claim ``locale`` → claim ``org_locale`` → ``ru``.

    Значение не сводится к списку поддерживаемых: агент с локалью ``pl`` всё равно отвечает LLM
    по-польски, а детерминированные строки :func:`t` возьмёт из ``en``. Невалидное значение
    пропускается, как и claims не-словарём: разрешение локали ход не роняет.
    """
    source: Mapping[str, Any] = claims if isinstance(claims, Mapping) else {}
    for value in (metadata_locale, source.get("locale"), source.get("org_locale")):
        locale = _explicit_locale(value)
        if locale:
            return locale
    return LEGACY_DEFAULT_LOCALE


def t(locale: str | None, translations: Mapping[str, T]) -> T:
    """Детерминированная строка агента на языке локали по цепочке :func:`locale_chain`.

    Значением может быть и функция-шаблон: ``t(locale, {"ru": lambda n: ..., "en": ...})(n)``.
    ``en`` в словаре обязателен; без него — первое значение словаря, а не исключение.
    """
    for tag in locale_chain(locale):
        if tag in translations:
            return translations[tag]
    return next(iter(translations.values()))


def locale_native_name(locale: str | None) -> str | None:
    """Название языка на нём самом или ``None``, если языка нет в :data:`SUPPORTED_LOCALES`."""
    for tag in _tag_prefixes(canonical_locale_tag(locale) or ""):
        supported = _find_supported(tag)
        if supported:
            return supported.native_name
    return None


def user_locale_instruction(locale: str) -> str:
    """Секция системного промпта о языке ответа и доменном контенте (docs#589 §1).

    Промпт остаётся на русском: язык промпта и язык ответа — разные вещи. Язык вне списка
    называется тегом BCP-47.
    """
    tag = canonical_locale_tag(locale) or LEGACY_DEFAULT_LOCALE
    name = locale_native_name(tag)
    language = f"{name} ({tag})" if name else f"язык с тегом BCP-47 «{tag}»"
    return "\n".join(
        [
            "## Язык ответа",
            f"Отвечай пользователю на языке: {language} — даже если вопрос, контекст или документы "
            "на другом языке. По возможности рассуждай на этом же языке.",
            "Всё, что относится к документам, оставляй на языке документа: цитаты норм (СП, ГОСТ, "
            "ПУЭ и др.), названия и номера документов, номера пунктов, ссылки вида "
            "«[название, пункт]». Пояснения к ним пиши на языке ответа.",
        ]
    )
