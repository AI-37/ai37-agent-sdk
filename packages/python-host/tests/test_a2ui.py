from ai37_agent_host.a2ui import component_to_a2ui_operations
from ai37_agent_host.types import A2uiComponent


def test_flatten_single():
    comp = A2uiComponent(component="SimpleTable", props={"title": "T"})
    ops = component_to_a2ui_operations(comp, surface_id="s1", catalog_id="cat")
    assert ops[0] == {"version": "v0.9", "createSurface": {"surfaceId": "s1", "catalogId": "cat"}}
    upd = ops[1]["updateComponents"]
    assert upd["surfaceId"] == "s1"
    assert upd["components"] == [{"id": "root", "component": "SimpleTable", "title": "T"}]


def test_flatten_children_list_slot():
    a = A2uiComponent(component="Text", props={"text": "a"})
    b = A2uiComponent(component="Text", props={"text": "b"})
    col = A2uiComponent(component="Column", children={"children": [a, b]})
    comps = component_to_a2ui_operations(col, surface_id="s", catalog_id="cat")[1][
        "updateComponents"
    ]["components"]
    assert comps[0]["id"] == "root"
    assert comps[0]["children"] == ["root.children.0", "root.children.1"]
    assert [c["id"] for c in comps] == ["root", "root.children.0", "root.children.1"]


def test_flatten_single_child_slot():
    inner = A2uiComponent(component="Text", props={"text": "x"})
    card = A2uiComponent(component="Card", children={"child": inner})
    comps = component_to_a2ui_operations(card, surface_id="s", catalog_id="cat")[1][
        "updateComponents"
    ]["components"]
    assert comps[0]["child"] == "root.child"
    assert comps[1]["id"] == "root.child"


def test_explicit_child_id_preserved():
    inner = A2uiComponent(component="Text", id="mine", props={"text": "x"})
    card = A2uiComponent(component="Card", children={"child": inner})
    comps = component_to_a2ui_operations(card, surface_id="s", catalog_id="cat")[1][
        "updateComponents"
    ]["components"]
    assert comps[0]["child"] == "mine"
    assert comps[1]["id"] == "mine"
