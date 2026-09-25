import pytest

from ai37_agent_sdk import (
    AI37_SHOWCASE_EXTENSION_URI,
    build_agent_showcase_extension,
    normalize_agent_showcase_profile,
    parse_agent_showcase_extension,
)


def test_builds_and_parses_full_profile():
    extension = build_agent_showcase_extension(
        {
            "title": " Расчёт лифтов ",
            "summary": "Подбор числа и параметров лифтов по этажности и заселённости",
            "computes": "Число лифтов, интервал движения, провозная способность группы",
            "norms": [
                {
                    "code": "ГОСТ 34758-2021",
                    "title": "Лифты. Определение числа, параметров и размеров лифтов",
                },
                {"code": "гост 34758-2021"},
            ],
            "starter": "Запусти расчёт лифтов",
            "examples": ["Подбери лифты для жилого дома 17 этажей", " "],
            "order": 3,
        }
    )
    assert extension["uri"] == AI37_SHOWCASE_EXTENSION_URI
    assert extension["required"] is False
    assert extension["params"]["title"] == "Расчёт лифтов"
    # Дубль норматива в другом регистре и пустой пример отбрасываются.
    assert len(extension["params"]["norms"]) == 1
    assert extension["params"]["examples"] == ["Подбери лифты для жилого дома 17 этажей"]
    assert parse_agent_showcase_extension([extension]) == extension["params"]


def test_empty_optional_fields_are_omitted():
    profile = normalize_agent_showcase_profile(
        {
            "title": "Проверка подрядчика",
            "summary": "Проверка контрагента по реестрам Минстроя",
            "norms": [],
            "examples": [],
            "computes": "   ",
        }
    )
    assert profile == {
        "title": "Проверка подрядчика",
        "summary": "Проверка контрагента по реестрам Минстроя",
    }


def test_over_long_text_is_clamped_and_marked():
    profile = normalize_agent_showcase_profile(
        {"title": "а" * 70, "summary": "б" * 200, "computes": "в" * 300}
    )
    assert len(profile["title"]) == 60
    assert profile["title"].endswith("…")
    assert len(profile["summary"]) == 160
    assert len(profile["computes"]) == 240


def test_extra_and_malformed_items_are_dropped():
    profile = normalize_agent_showcase_profile(
        {
            "title": "Расчёт КЕО",
            "summary": "Коэффициент естественной освещённости помещений",
            "norms": [
                {"code": "СП 52.13330"},
                "СП 367.1325800.2017",
                {"title": "без кода"},
                {"code": "ГОСТ Р 21.514—2025"},
                {"code": "СП 23-102-2003"},
                {"code": "СанПиН 1.2.3685-21"},
                {"code": "пятый лишний"},
            ],
            "examples": ["первый", "второй", "третий", "четвёртый", "пятый"],
        }
    )
    assert [norm["code"] for norm in profile["norms"]] == [
        "СП 52.13330",
        "ГОСТ Р 21.514—2025",
        "СП 23-102-2003",
        "СанПиН 1.2.3685-21",
    ]
    assert profile["examples"] == ["первый", "второй", "третий", "четвёртый"]


def test_order_keeps_integers_only():
    numbered = normalize_agent_showcase_profile({"title": "т", "summary": "с", "order": 2})
    assert numbered["order"] == 2
    # bool — подтип int, в порядок витрины он попасть не должен.
    for order in (1.5, "3", True, None):
        assert "order" not in normalize_agent_showcase_profile(
            {"title": "т", "summary": "с", "order": order}
        )


def test_title_and_summary_are_required():
    with pytest.raises(TypeError):
        normalize_agent_showcase_profile({"summary": "есть"})
    with pytest.raises(TypeError):
        normalize_agent_showcase_profile({"title": "есть", "summary": "  "})
    with pytest.raises(TypeError):
        normalize_agent_showcase_profile(["не объект"])


def test_missing_or_broken_extension_is_ignored():
    assert parse_agent_showcase_extension(None) is None
    assert parse_agent_showcase_extension([{"uri": "urn:other", "params": {}}]) is None
    assert (
        parse_agent_showcase_extension(
            [{"uri": AI37_SHOWCASE_EXTENSION_URI, "params": {"summary": "без заголовка"}}]
        )
        is None
    )


def test_control_characters_and_angle_brackets_are_stripped():
    profile = normalize_agent_showcase_profile(
        {"title": "Расчёт\a ОВиК", "summary": "<script>alert(1)</script> расчёт"}
    )
    assert profile["title"] == "Расчёт ОВиК"
    assert profile["summary"] == "script alert(1) /script расчёт"
