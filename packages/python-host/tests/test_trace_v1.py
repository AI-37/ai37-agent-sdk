from ai37_agent_host.observability import TRACE_SCHEMA_VERSION, trace_metadata


def test_trace_metadata_matches_shared_envelope():
    result = trace_metadata(
        "turn",
        turn_id="turn-1",
        session_id="session-1",
        service="test-agent",
        environment="test",
        status="working",
    )

    assert result == {
        "schemaVersion": TRACE_SCHEMA_VERSION,
        "traceKind": "turn",
        "service": "test-agent",
        "environment": "test",
        "turnId": "turn-1",
        "sessionId": "session-1",
        "status": "working",
    }
