from ai37_agent_sdk import (
    OUTPUT_MODE_MARKDOWN,
    OUTPUT_MODE_MARKDOWN_SPAI,
    OUTPUT_MODE_TEXT,
    TEXT_OUTPUT_MODES,
    is_text_output_mode,
)


def test_output_mode_constants():
    assert OUTPUT_MODE_TEXT == "text/plain"
    assert OUTPUT_MODE_MARKDOWN == "text/markdown"
    assert OUTPUT_MODE_MARKDOWN_SPAI == "text/vnd.markdown+spai-renderer"


def test_text_output_modes_order():
    # По убыванию «богатства» — зеркало TS TEXT_OUTPUT_MODES.
    assert TEXT_OUTPUT_MODES == (
        OUTPUT_MODE_MARKDOWN_SPAI,
        OUTPUT_MODE_MARKDOWN,
        OUTPUT_MODE_TEXT,
    )


def test_is_text_output_mode():
    assert is_text_output_mode(OUTPUT_MODE_MARKDOWN_SPAI)
    assert is_text_output_mode("text/plain")
    assert not is_text_output_mode("application/json")
    assert not is_text_output_mode("text/vnd.a2ui+json")
