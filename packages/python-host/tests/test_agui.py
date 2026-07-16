"""Тесты AG-UI SSE-адаптера — чистые хелперы + graceful-degradation без пакета ``ag-ui``.

``ag_ui`` (протокол/энкодер) не установлен в host-env (optional-группа ``agui``), поэтому
кодирование событий не покрываем — только чистую логику разбора тела/негоциации и то, что
фабрика роутов при отсутствии пакета бросает понятную ошибку (soft-import, как ``langfuse``).
"""

from ai37_agent_host import agui
from ai37_agent_host.agui import (
    build_agent_input,
    extract_ai37,
    last_user_text,
    read_a2ui_action,
)

# ── read_a2ui_action: forwardedProps.a2uiAction.userAction → A2uiAction ───────


def test_read_a2ui_action_full():
    fp = {
        "a2uiAction": {
            "userAction": {
                "name": "submit",
                "context": {"k": "v"},
                "surfaceId": "surf-1",
                "sourceComponentId": "btn-1",
            }
        }
    }
    action = read_a2ui_action(fp)
    assert action is not None
    assert action.name == "submit"
    assert action.context == {"k": "v"}
    assert action.surface_id == "surf-1"
    assert action.source_component_id == "btn-1"


def test_read_a2ui_action_minimal_defaults_context():
    action = read_a2ui_action({"a2uiAction": {"userAction": {"name": "click"}}})
    assert action is not None
    assert action.name == "click"
    assert action.context == {}
    assert action.surface_id is None
    assert action.source_component_id is None


def test_read_a2ui_action_none_when_no_action_or_bad_name():
    assert read_a2ui_action(None) is None
    assert read_a2ui_action({}) is None
    assert read_a2ui_action({"a2uiAction": {}}) is None
    # name не строка → нет действия
    assert read_a2ui_action({"a2uiAction": {"userAction": {"name": 42}}}) is None


# ── last_user_text: content = str | [{type:'text', text}] ────────────────────


def test_last_user_text_string_content():
    messages = [
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "привет"},
    ]
    assert last_user_text(messages) == "привет"


def test_last_user_text_parts_content():
    messages = [
        {"role": "user", "content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]},
    ]
    assert last_user_text(messages) == "ab"


def test_last_user_text_takes_last_user_message():
    messages = [
        {"role": "user", "content": "first"},
        {"role": "assistant", "content": "reply"},
        {"role": "user", "content": "second"},
    ]
    assert last_user_text(messages) == "second"


def test_last_user_text_none_when_no_user():
    assert last_user_text(None) is None
    assert last_user_text([]) is None
    assert last_user_text([{"role": "assistant", "content": "x"}]) is None


# ── extract_ai37: metadata.ai37 из forwardedProps ────────────────────────────


def test_extract_ai37_from_forwarded_props():
    body = {
        "threadId": "outer-thread",
        "forwardedProps": {
            "ai37": {
                "tenant": "acme",
                "appId": "chat",
                "channel": "web",
                "trace_id": "t-1",
                "acceptedOutputModes": ["text/markdown"],
            }
        },
    }
    meta = extract_ai37(body)
    assert meta.tenant == "acme"
    assert meta.app_id == "chat"
    assert meta.channel == "web"
    assert meta.trace_id == "t-1"
    assert meta.accepted_output_modes == ["text/markdown"]
    # thread_id из ai37 отсутствует → добирается из body.threadId
    assert meta.thread_id == "outer-thread"


def test_extract_ai37_thread_id_priority():
    # ai37.thread_id имеет приоритет над body.threadId
    body = {
        "threadId": "outer",
        "forwardedProps": {"ai37": {"thread_id": "inner"}},
    }
    assert extract_ai37(body).thread_id == "inner"


def test_extract_ai37_empty_body():
    meta = extract_ai37({})
    assert meta.thread_id is None
    assert meta.tenant is None
    assert meta.accepted_output_modes is None


# ── build_agent_input: сборка нормализованного входа + негоциация ────────────


def _negotiation(catalog_ids):
    from ai37_agent_host import OutputNegotiation

    return OutputNegotiation(
        text="text/plain",
        catalog_ids=list(catalog_ids),
        catalog_id=catalog_ids[0] if catalog_ids else None,
    )


def test_build_agent_input_collects_fields():
    body = {
        "messages": [{"role": "user", "content": "вопрос"}],
        "forwardedProps": {
            "data": {"foo": 1},
            "a2uiAction": {"userAction": {"name": "submit"}},
        },
    }
    meta = extract_ai37(body)
    inp = build_agent_input(
        body,
        negotiation=_negotiation(["cat"]),
        metadata=meta,
        thread_id="th-1",
        accepted_output_modes=["text/markdown"],
        supported_catalog_ids=["cat"],
        prior_state={"step": 2},
        claims=None,
        billing_org_id="org-9",
    )
    assert inp.text == "вопрос"
    assert inp.data == {"foo": 1}
    assert inp.task_id == "th-1"
    assert inp.context_id == "th-1"
    assert inp.action is not None and inp.action.name == "submit"
    assert inp.accepted_output_modes == ["text/markdown"]
    assert inp.supported_catalog_ids == ["cat"]
    assert inp.task_state == {"step": 2}
    assert inp.billing_org_id == "org-9"


def test_build_agent_input_empty_supported_catalog_ids_becomes_none():
    body = {"messages": [], "forwardedProps": {}}
    inp = build_agent_input(
        body,
        negotiation=_negotiation([]),
        metadata=extract_ai37(body),
        thread_id="th-2",
        accepted_output_modes=None,
        supported_catalog_ids=[],
        prior_state=None,
    )
    assert inp.text is None
    assert inp.data == {}
    assert inp.action is None
    # пустой список → None (симметрия с A2A-путём)
    assert inp.supported_catalog_ids is None
    assert inp.task_state is None


# ── graceful-degradation: soft-import ag_ui (пакет не установлен) ─────────────


def test_agui_module_imports_without_package():
    # модуль грузится без optional-группы agui (soft-import не роняет импорт)
    assert agui._AGUI_IMPORT_ERROR is not None


def test_agui_routes_raises_clear_error_without_package():
    class _Handler:
        async def run(self, req):  # pragma: no cover - тело не вызывается
            raise AssertionError

    try:
        agui.agui_routes(_Handler())
        raise AssertionError("должно было бросить RuntimeError про optional-группу agui")
    except RuntimeError as exc:
        assert "ag-ui" in str(exc)
        assert "agui" in str(exc)
