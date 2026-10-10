import logging

from ai37_agent_sdk import (
    REDACTED,
    SecretRedactingFilter,
    redact_for_log,
    redact_secrets_in_text,
)
from ai37_agent_sdk.testing import InMemoryBillingClient, fixtures, make_test_context

JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl"
LLM_KEY = "sk-AbCdEfGhIjKlMnOpQrStUv"


def test_text_patterns():
    assert redact_secrets_in_text(f"hint={JWT} x") == f"hint={REDACTED} x"
    bearer = redact_secrets_in_text("Authorization: Bearer abc.def")
    assert bearer == f"Authorization: Bearer {REDACTED}"
    assert redact_secrets_in_text(f"key {LLM_KEY}.") == f"key {REDACTED}."
    plain = "task sk-1 done; skill=calc"
    assert redact_secrets_in_text(plain) == plain


def test_redact_for_log_by_key_name_strings_only():
    data = {
        "password": "p",
        "nested": {"api_key": "a", "deeper": {"client_secret": "s", "llmKey": "k"}},
        "headers": {"Authorization": "Basic x", "Cookie": "sid=1"},
        "remaining_total_tokens": 15516085,
        "items": [JWT, "ok"],
        "task_id": "t1",
    }
    out = redact_for_log(data)
    assert out == {
        "password": REDACTED,
        "nested": {"api_key": REDACTED, "deeper": {"client_secret": REDACTED, "llmKey": REDACTED}},
        "headers": {"Authorization": REDACTED, "Cookie": REDACTED},
        "remaining_total_tokens": 15516085,
        "items": [REDACTED, "ok"],
        "task_id": "t1",
    }
    assert data["password"] == "p"


def test_redact_for_log_cycles_and_agent_context():
    loop: dict = {"token": "x"}
    loop["self"] = loop
    assert redact_for_log(loop)["self"] == "[Circular]"

    ctx = make_test_context(
        claims={"sub": "u1", "org_id": "o1", "billing_org_id": "b1"},
        billing=InMemoryBillingClient(runtime_state=fixtures.runtime_state.active()),
    )
    ctx.assert_execution_allowed()
    out = redact_for_log({"state": {"ctx": ctx}})
    assert out["state"]["ctx"]["has_llm_key"] is True
    assert "sk-test-llm" not in repr(out)
    assert "test.token" not in repr(out)


def test_filter_masks_message_args_and_extra(caplog):
    logger = logging.getLogger("ai37.test.redaction")
    handler = caplog.handler
    redacting = SecretRedactingFilter()
    handler.addFilter(redacting)
    try:
        with caplog.at_level(logging.INFO, logger="ai37.test.redaction"):
            logger.info(
                "call with Bearer %s and %s",
                JWT,
                LLM_KEY,
                extra={"api_key": "raw", "payload": {"password": "p", "n": 1}},
            )
    finally:
        handler.removeFilter(redacting)
    record = caplog.records[-1]
    text = record.getMessage()
    assert JWT not in text and LLM_KEY not in text
    assert record.api_key == REDACTED
    assert record.payload == {"password": REDACTED, "n": 1}
