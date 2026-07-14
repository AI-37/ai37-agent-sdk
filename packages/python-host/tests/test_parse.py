from types import SimpleNamespace

from a2a.types import Message
from google.protobuf.json_format import ParseDict

from ai37_agent_host.parse import parse_a2a_message


def _rc(payload: dict) -> SimpleNamespace:
    return SimpleNamespace(message=ParseDict(payload, Message(), ignore_unknown_fields=True))


def test_parse_text_and_data():
    rc = _rc({"role": "ROLE_USER", "parts": [{"text": "hi"}, {"data": {"inn": "123"}}]})
    p = parse_a2a_message(rc)
    assert p.text == "hi"
    assert p.data == {"inn": "123"}


def test_parse_ai37_metadata_and_context_files():
    rc = _rc(
        {
            "role": "ROLE_USER",
            "parts": [{"text": "проверь"}],
            "metadata": {
                "ai37": {
                    "tenant": "t1",
                    "context_refs": ["chat-attachment:1"],
                    "context_files": [
                        {
                            "ref": "chat-attachment:1",
                            "name": "list.xlsx",
                            "scope": "chat",
                            "isLarge": True,
                        }
                    ],
                    "trace_id": "abc",
                    "acceptedOutputModes": ["text/markdown"],
                },
                "a2uiClientCapabilities": {"v0.9": {"supportedCatalogIds": ["u1", "u2"]}},
                "traceparent": "00-trace",
            },
        }
    )
    p = parse_a2a_message(rc)
    assert p.metadata.tenant == "t1"
    assert p.metadata.context_refs == ["chat-attachment:1"]
    assert p.metadata.context_files is not None
    cf = p.metadata.context_files[0]
    assert cf.ref == "chat-attachment:1"
    assert cf.name == "list.xlsx"
    assert cf.scope == "chat"
    assert cf.is_large is True
    assert p.metadata.trace_id == "abc"
    assert p.metadata.accepted_output_modes == ["text/markdown"]
    assert p.supported_catalog_ids == ["u1", "u2"]
    assert p.trace_carrier == {"traceparent": "00-trace"}


def test_parse_a2ui_action():
    rc = _rc(
        {
            "role": "ROLE_USER",
            "parts": [{"text": "x"}],
            "metadata": {
                "a2uiAction": {
                    "userAction": {
                        "name": "submit_type",
                        "context": {"contractorType": "producer"},
                        "surfaceId": "s1",
                    }
                }
            },
        }
    )
    p = parse_a2a_message(rc)
    assert p.action is not None
    assert p.action.name == "submit_type"
    assert p.action.context == {"contractorType": "producer"}
    assert p.action.surface_id == "s1"


def test_parse_ai37_from_data_part():
    rc = _rc({"role": "ROLE_USER", "parts": [{"data": {"ai37": {"tenant": "d"}}}]})
    p = parse_a2a_message(rc)
    assert p.metadata.tenant == "d"


def test_message_metadata_overrides_data():
    rc = _rc(
        {
            "role": "ROLE_USER",
            "parts": [{"data": {"ai37": {"tenant": "from_data"}}}],
            "metadata": {"ai37": {"tenant": "from_msg"}},
        }
    )
    p = parse_a2a_message(rc)
    assert p.metadata.tenant == "from_msg"
