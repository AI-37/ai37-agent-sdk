from google.protobuf.json_format import MessageToDict

from ai37_agent_host.build_task import (
    component_to_dict,
    data_part,
    resolve_result_a2ui,
    text_part,
)
from ai37_agent_host.types import A2uiComponent, AgentResult, OutputNegotiation


def test_component_to_dict_nested():
    inner = A2uiComponent(component="Text", props={"text": "a"})
    card = A2uiComponent(component="Card", props={"title": "T"}, children={"child": inner})
    assert component_to_dict(card) == {
        "component": "Card",
        "props": {"title": "T"},
        "children": {"child": {"component": "Text", "props": {"text": "a"}}},
    }


def test_component_to_dict_catalog_and_id():
    c = A2uiComponent(component="SimpleTable", props={}, id="root", catalog_id="cat")
    assert component_to_dict(c) == {
        "component": "SimpleTable",
        "props": {},
        "id": "root",
        "catalogId": "cat",
    }


def test_resolve_result_a2ui_negotiated():
    neg = OutputNegotiation(text="text/plain", catalog_ids=["cat"], catalog_id="cat")
    res = AgentResult(status="completed", a2ui=[A2uiComponent(component="SimpleTable", props={})])
    a2ui, followup = resolve_result_a2ui(res, neg)
    assert a2ui == [{"component": "SimpleTable", "props": {}}]
    assert followup == []


def test_resolve_result_a2ui_filtered_when_no_catalog():
    neg = OutputNegotiation(text="text/plain", catalog_ids=[], catalog_id=None)
    res = AgentResult(status="completed", a2ui=[A2uiComponent(component="SimpleTable", props={})])
    a2ui, _ = resolve_result_a2ui(res, neg)
    assert a2ui == []


def test_resolve_followup_hitl():
    neg = OutputNegotiation(text="text/plain", catalog_ids=["cat"], catalog_id="cat")
    res = AgentResult(
        status="input-required",
        followup=A2uiComponent(component="ChoiceCard", props={"choices": []}),
    )
    _, followup = resolve_result_a2ui(res, neg)
    assert followup == [{"component": "ChoiceCard", "props": {"choices": []}}]


def test_parts_build():
    assert text_part("hi").text == "hi"
    assert MessageToDict(data_part({"k": "v"})).get("data") == {"k": "v"}
