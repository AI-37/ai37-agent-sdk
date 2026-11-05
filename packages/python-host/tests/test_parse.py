from types import SimpleNamespace

from a2a.types import Message
from google.protobuf.json_format import ParseDict

from ai37_agent_host.parse import parse_a2a_message

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


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
                            "mime": XLSX_MIME,
                            "hasRaw": True,
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
    assert cf.mime == XLSX_MIME
    assert cf.has_raw is True
    assert p.metadata.trace_id == "abc"
    assert p.metadata.accepted_output_modes == ["text/markdown"]
    assert p.supported_catalog_ids == ["u1", "u2"]
    assert p.trace_carrier == {"traceparent": "00-trace"}


def _files(*entries: dict) -> list:
    rc = _rc(
        {
            "role": "ROLE_USER",
            "parts": [{"text": "x"}],
            "metadata": {"ai37": {"context_files": list(entries)}},
        }
    )
    return parse_a2a_message(rc).metadata.context_files


def test_parse_context_file_recognition():
    ready, rejected = _files(
        {
            "ref": "project-attachment:1",
            "name": "Схема ОВ.pdf",
            "scope": "project",
            "recognition": {"state": "ready", "seriesId": "s-1", "pageCount": 40},
        },
        {
            "ref": "chat-attachment:2",
            "name": "Фото.png",
            "scope": "chat",
            "recognition": {
                "state": "rejected",
                "code": "unsupported_format",
                "reason": "формат не поддерживается",
            },
        },
    )
    assert ready.recognition is not None
    assert ready.recognition.state == "ready"
    assert ready.recognition.series_id == "s-1"
    assert ready.recognition.page_count == 40
    assert ready.recognition.code is None
    assert rejected.recognition is not None
    assert rejected.recognition.state == "rejected"
    assert rejected.recognition.series_id is None
    assert rejected.recognition.code == "unsupported_format"
    assert rejected.recognition.reason == "формат не поддерживается"


def test_parse_context_file_without_or_with_unknown_recognition():
    plain, unknown, broken = _files(
        {"ref": "chat-attachment:1", "name": "a.pdf", "scope": "chat"},
        {
            "ref": "chat-attachment:2",
            "name": "b.pdf",
            "scope": "chat",
            "recognition": {"state": "processing", "seriesId": "s-2"},
        },
        {
            "ref": "chat-attachment:3",
            "name": "c.pdf",
            "scope": "chat",
            "recognition": {"state": "ready", "seriesId": 7, "pageCount": "40"},
        },
    )
    assert plain.recognition is None
    # Промежуточное состояние агенту не приходит: незнакомое трактуем как отсутствие поля.
    assert unknown.recognition is None
    assert broken.recognition is not None
    assert broken.recognition.series_id is None
    assert broken.recognition.page_count is None


def test_parse_context_file_kind():
    voice, plain, unknown = _files(
        {"ref": "chat-attachment:1", "name": "voice-1.webm", "scope": "chat", "kind": "voice"},
        {"ref": "chat-attachment:2", "name": "meeting.mp3", "scope": "chat", "mime": "audio/mpeg"},
        {"ref": "chat-attachment:3", "name": "c.pdf", "scope": "chat", "kind": "sketch"},
    )
    assert voice.kind == "voice"
    # Аудио, приложенное через «+», — обычный документ, хотя mime у него тоже audio/*.
    assert plain.kind is None
    # Вид, которого агент не знает, читается как обычный файл.
    assert unknown.kind is None


def test_parse_trace_carrier_keeps_tracestate_and_baggage():
    # Ключи как у injectTraceContext ts-host: плоско в message.metadata, рядом с конвертом ai37.
    rc = _rc(
        {
            "role": "ROLE_USER",
            "parts": [{"text": "x"}],
            "metadata": {
                "ai37": {"context_refs": ["monitoring:project:42"]},
                "traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
                "tracestate": "vendor=1",
                "baggage": "k=v",
            },
        }
    )
    assert parse_a2a_message(rc).trace_carrier == {
        "traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        "tracestate": "vendor=1",
        "baggage": "k=v",
    }


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


def test_context_file_without_mime_stays_none():
    """Продюсер постарше поля не шлёт — агент обязан увидеть None, а не упасть."""
    rc = _rc(
        {
            "role": "ROLE_USER",
            "parts": [{"text": "проверь"}],
            "metadata": {
                "ai37": {
                    "context_files": [
                        {"ref": "chat-attachment:1", "name": "list.xlsx", "scope": "chat"}
                    ],
                },
            },
        }
    )
    cf = parse_a2a_message(rc).metadata.context_files[0]
    assert cf.mime is None
    assert cf.has_raw is None
