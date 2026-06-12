from ai37_agent_sdk.testing import fixtures


def test_active_has_tokens_and_llm_key():
    state = fixtures.runtime_state.active()
    assert state.entitlement_status == "active"
    assert state.remaining_total_tokens > 0
    assert state.llm_key


def test_no_resources():
    state = fixtures.runtime_state.no_resources()
    assert state.entitlement_status == "no_resources"
    assert state.remaining_total_tokens == 0


def test_feature_allowed_vs_denied():
    allowed = fixtures.runtime_state.feature_allowed("f", "p")
    assert allowed.features[0].privileges[0].value is True
    denied = fixtures.runtime_state.feature_denied("f", "p")
    assert denied.features[0].privileges[0].value is False


def test_overrides():
    state = fixtures.runtime_state.active(remaining_total_tokens=42, llm_key="sk-z")
    assert state.remaining_total_tokens == 42
    assert state.llm_key == "sk-z"
