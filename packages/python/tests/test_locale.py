"""Локаль: паритет с TS ``test/locale.test.ts`` (те же векторы)."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

import pytest

from ai37_agent_sdk import (
    BILLING_USER_MESSAGES,
    BILLING_USER_MESSAGES_BY_LOCALE,
    DEFAULT_BILLING_USER_MESSAGE,
    DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE,
    FALLBACK_LOCALE,
    LEGACY_DEFAULT_LOCALE,
    SUPPORTED_LOCALES,
    BillingExecutionDeniedError,
    BillingRuntimeState,
    billing_user_message,
    canonical_locale_tag,
    friendly_billing_message,
    locale_chain,
    locale_native_name,
    locale_variant_chain,
    normalize_locale,
    pick_locale_variant,
    resolve_request_locale,
    t,
    user_locale_instruction,
)

TAGS = [loc.tag for loc in SUPPORTED_LOCALES]


def test_supported_locales_first_wave_with_native_names() -> None:
    assert TAGS == ["ru", "en", "es", "de", "fr", "pt"]
    assert all(loc.native_name for loc in SUPPORTED_LOCALES)


def test_supported_locales_are_immutable() -> None:
    assert isinstance(SUPPORTED_LOCALES, tuple)
    with pytest.raises(dataclasses.FrozenInstanceError):
        SUPPORTED_LOCALES[0].tag = "xx"  # type: ignore[misc]


#: Общие векторы с TS (``contract/locale.vectors.json``): обе реализации дают один результат.
VECTORS = json.loads(
    (Path(__file__).resolve().parents[3] / "contract" / "locale.vectors.json").read_text("utf-8")
)


def test_supported_locales_match_contract() -> None:
    assert TAGS == VECTORS["supportedLocales"]


@pytest.mark.parametrize(("raw", "expected"), VECTORS["canonicalLocaleTag"])
def test_vectors_canonical_locale_tag(raw: object, expected: str | None) -> None:
    assert canonical_locale_tag(raw) == expected


@pytest.mark.parametrize(("raw", "expected"), VECTORS["localeChain"])
def test_vectors_locale_chain(raw: str | None, expected: list[str]) -> None:
    assert locale_chain(raw) == expected


@pytest.mark.parametrize(("raw", "expected"), VECTORS["localeVariantChain"])
def test_vectors_locale_variant_chain(raw: str | None, expected: list[str]) -> None:
    assert locale_variant_chain(raw) == expected


@pytest.mark.parametrize("case", VECTORS["pickLocaleVariant"])
def test_vectors_pick_locale_variant(case: dict[str, Any]) -> None:
    assert pick_locale_variant(case["variants"], case["locale"]) == case["expected"]


@pytest.mark.parametrize(("raw", "expected"), VECTORS["normalizeLocale"])
def test_vectors_normalize_locale(raw: str | None, expected: str) -> None:
    assert normalize_locale(raw) == expected


@pytest.mark.parametrize("case", VECTORS["resolveRequestLocale"])
def test_vectors_resolve_request_locale(case: dict[str, Any]) -> None:
    assert resolve_request_locale(case["metadata"], case["claims"]) == case["expected"]


@pytest.mark.parametrize(("locale", "text"), sorted(VECTORS["userLocaleInstruction"].items()))
def test_vectors_user_locale_instruction_exact_text(locale: str, text: str) -> None:
    assert user_locale_instruction(locale) == text


@pytest.mark.parametrize(("reason", "locale", "text"), VECTORS["billingUserMessage"])
def test_vectors_billing_user_message(reason: str, locale: str | None, text: str) -> None:
    if locale is None:
        assert billing_user_message(reason) == text
    else:
        assert billing_user_message(reason, locale) == text


def test_resolve_request_locale_meaning() -> None:
    # Конверт важнее claims; без всего — ru (обратная совместимость).
    assert resolve_request_locale("es", {"locale": "de", "org_locale": "fr"}) == "es"
    assert resolve_request_locale(None, None) == LEGACY_DEFAULT_LOCALE
    # §10: язык вне списка не отвергается, тег с регионом не обрезается.
    assert resolve_request_locale("pl", None) == "pl"
    assert resolve_request_locale("es-mx", None) == "es-MX"
    # Claims не словарём (фейк в тестах агента) — не падаем, идём дальше по цепочке.
    assert resolve_request_locale(None, object()) == "ru"
    assert normalize_locale("uk") == FALLBACK_LOCALE


def test_t_follows_chain() -> None:
    texts = {"ru": "Готово", "en": "Done", "es": "Hecho", "es-MX": "Listo"}
    assert t("es-MX", texts) == "Listo"
    assert t("es-ES", texts) == "Hecho"
    assert t("ru", texts) == "Готово"
    # §10: язык вне словаря (pl) → en, без падения.
    assert t("pl", texts) == "Done"
    assert t("de", texts) == "Done"
    assert t(None, texts) == "Done"


def test_t_with_template_functions() -> None:
    texts = {"ru": lambda n: f"{n} шт.", "en": lambda n: f"{n} pcs", "es": lambda n: f"{n} uds."}
    assert t("es", texts)(3) == "3 uds."


def test_t_without_en_returns_first_value_instead_of_raising() -> None:
    assert t("pl", {"ru": "Готово"}) == "Готово"


def test_user_locale_instruction_region_and_unknown_language() -> None:
    assert "Español (es-MX)" in user_locale_instruction("es-mx")
    assert "«pl»" in user_locale_instruction("pl")
    assert locale_native_name("pl") is None


def test_billing_messages_cover_every_supported_locale() -> None:
    every = [*BILLING_USER_MESSAGES_BY_LOCALE.values(), DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE]
    for texts in every:
        assert sorted(texts) == sorted(TAGS)


def test_billing_user_message_without_locale_is_russian() -> None:
    assert billing_user_message("NO_TOKENS") == BILLING_USER_MESSAGES["NO_TOKENS"]
    assert "Платёж не прошёл" in BILLING_USER_MESSAGES["PAYMENT_FAILED"]
    assert "подписку" in DEFAULT_BILLING_USER_MESSAGE


def test_billing_user_message_by_locale() -> None:
    by_reason = BILLING_USER_MESSAGES_BY_LOCALE
    assert billing_user_message("NO_TOKENS", "es") == by_reason["NO_TOKENS"]["es"]
    state = BillingRuntimeState(
        org_id="o",
        billing_org_id="b",
        entitlement_status="payment_failed",
        remaining_total_tokens=0,
    )
    err = BillingExecutionDeniedError(state)
    assert err.reason == "PAYMENT_FAILED"
    assert friendly_billing_message(err, "de") == by_reason["PAYMENT_FAILED"]["de"]


def test_billing_user_message_unknown_reason_and_fallbacks() -> None:
    default = DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE
    assert billing_user_message(RuntimeError("boom"), "fr") == default["fr"]
    assert billing_user_message(None, "pt") == default["pt"]
    # §10: язык вне словаря → en; регион → язык.
    missing = BILLING_USER_MESSAGES_BY_LOCALE["MISSING_FEATURE"]
    assert billing_user_message("MISSING_FEATURE", "pl") == missing["en"]
    assert billing_user_message("MISSING_FEATURE", "pt-BR") == missing["pt"]
