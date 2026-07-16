from ai37_agent_host import OutputNegotiation
from ai37_agent_host.output_modes import (
    filter_a2ui_by_catalog,
    negotiate_catalogs,
    negotiate_output,
    negotiate_text,
    read_client_capabilities,
)
from ai37_agent_host.types import A2uiComponent


def test_negotiate_text_intersection():
    assert (
        negotiate_text(["text/markdown", "text/plain"], ["text/plain", "text/markdown"])
        == "text/markdown"
    )
    # нет пересечения → text/plain
    assert negotiate_text(["application/json"], ["text/markdown"]) == "text/plain"
    assert negotiate_text(None, ["text/markdown"]) == "text/plain"


def test_negotiate_catalogs_client_order():
    # порядок предпочтения — клиента
    assert negotiate_catalogs(["catB", "catA"], ["catA", "catB"]) == ["catB", "catA"]
    assert negotiate_catalogs(["catB"], "catA") == []
    assert negotiate_catalogs(["catA"], None) == []


def test_read_client_capabilities():
    src = {"a2uiClientCapabilities": {"v0.9": {"supportedCatalogIds": ["u1", "u2"]}}}
    assert read_client_capabilities(src) == ["u1", "u2"]
    assert read_client_capabilities({}) == []
    assert read_client_capabilities(None) == []


def test_negotiate_output_scalar_alias():
    neg = negotiate_output(
        accepted_output_modes=["text/markdown"],
        agent_text_modes=["text/markdown", "text/plain"],
        supported_catalog_ids=["cat"],
        agent_catalog_ids=["cat"],
    )
    assert neg.text == "text/markdown"
    assert neg.catalog_ids == ["cat"]
    assert neg.catalog_id == "cat"


def test_filter_a2ui_by_catalog():
    neg = OutputNegotiation(
        text="text/plain", catalog_ids=["primary", "base"], catalog_id="primary"
    )
    comps = [
        A2uiComponent(component="X"),  # без catalog_id → первичный
        A2uiComponent(component="Y", catalog_id="base"),
        A2uiComponent(component="Z", catalog_id="other"),
    ]
    kept = [c.component for c in filter_a2ui_by_catalog(comps, neg)]
    assert kept == ["X", "Y"]
    # каталог не согласован → []
    neg0 = OutputNegotiation(text="text/plain", catalog_ids=[], catalog_id=None)
    assert filter_a2ui_by_catalog(comps, neg0) == []
