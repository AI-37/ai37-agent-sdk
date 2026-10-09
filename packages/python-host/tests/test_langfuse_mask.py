"""Маска содержимого Langfuse — паритет с ``langfuseContentMask`` ts-host.

Маска клиента (``Langfuse(mask=...)``) — единственное, что закрывает наблюдения, которые строит не
хост, а ``langfuse.langchain.CallbackHandler`` (промпты и ответы модели). SDK применяет её к input,
output и metadata, поэтому служебную метаданную хода приходится пропускать явно.
"""

import json

import pytest

from ai37_agent_host.observability import (
    TRACE_SCHEMA_VERSION,
    is_langfuse_content_captured,
    langfuse_content_mask,
    trace_metadata,
)

SECRET = "ООО «Ромашка», ИНН 7701234567, директор Иванов И. И."


def test_content_is_replaced_by_marker_with_size():
    assert langfuse_content_mask(data=SECRET) == {"redacted": True, "chars": len(SECRET)}


def test_object_prompt_is_redacted_too():
    masked = langfuse_content_mask(data={"messages": [{"role": "user", "content": SECRET}]})
    assert masked["redacted"] is True
    assert "Ромашка" not in json.dumps(masked, ensure_ascii=False)


@pytest.mark.parametrize("data", [SECRET, {"prompt": SECRET}, [SECRET], 42])
def test_marker_never_leaks_content(data):
    masked = langfuse_content_mask(data=data)
    assert "Ромашка" not in json.dumps(masked, ensure_ascii=False)


def test_none_stays_none():
    assert langfuse_content_mask(data=None) is None


def test_own_trace_metadata_passes_as_dict():
    meta = trace_metadata(
        "turn", service="minstroy", turn_id="t1", session_id="c1", status="completed"
    )
    assert langfuse_content_mask(data=meta) is meta


@pytest.mark.parametrize("separators", [(",", ":"), (", ", ": ")])
def test_own_trace_metadata_passes_serialized(separators):
    serialized = json.dumps(
        trace_metadata("turn", turn_id="t", session_id="s"), separators=separators
    )
    assert TRACE_SCHEMA_VERSION in serialized
    assert langfuse_content_mask(data=serialized) == serialized


def test_mask_accepts_sdk_kwargs():
    # SDK зовёт mask(data=..., **kwargs) — лишние ключи не должны ронять маску.
    assert langfuse_content_mask(data=SECRET, field="input")["redacted"] is True


def test_capture_is_off_by_default(monkeypatch):
    monkeypatch.delenv("LANGFUSE_CAPTURE_CONTENT", raising=False)
    assert is_langfuse_content_captured() is False


def test_capture_can_be_enabled_explicitly(monkeypatch):
    monkeypatch.setenv("LANGFUSE_CAPTURE_CONTENT", "true")
    assert is_langfuse_content_captured() is True


class _FakeLangfuse:
    """Подмена клиента: запоминает аргументы конструктора — проверяем, что маска подключена."""

    kwargs: dict = {}

    def __init__(self, **kwargs):
        type(self).kwargs = kwargs


@pytest.fixture
def fake_langfuse(monkeypatch):
    import sys
    import types

    import ai37_agent_host.observability.langfuse as lf

    module = types.ModuleType("langfuse")
    module.Langfuse = _FakeLangfuse
    monkeypatch.setitem(sys.modules, "langfuse", module)
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-test")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-test")
    monkeypatch.delenv("LANGFUSE_TRACING_ENABLED", raising=False)
    monkeypatch.setattr(lf, "_client", lf._UNSET)
    yield lf
    monkeypatch.setattr(lf, "_client", lf._UNSET)


def test_client_gets_mask_by_default(fake_langfuse, monkeypatch):
    monkeypatch.delenv("LANGFUSE_CAPTURE_CONTENT", raising=False)
    assert fake_langfuse._ensure_client() is not None
    assert _FakeLangfuse.kwargs["mask"] is langfuse_content_mask


def test_client_without_mask_when_capture_enabled(fake_langfuse, monkeypatch):
    monkeypatch.setenv("LANGFUSE_CAPTURE_CONTENT", "true")
    assert fake_langfuse._ensure_client() is not None
    assert _FakeLangfuse.kwargs["mask"] is None
