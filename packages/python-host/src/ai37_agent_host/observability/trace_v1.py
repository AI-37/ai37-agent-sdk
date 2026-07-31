"""Stable trace metadata envelope shared with the TypeScript host."""

from __future__ import annotations

import os
from typing import Any, Literal

TRACE_SCHEMA_VERSION = "trace.v1"
TraceKind = Literal["turn", "planner", "agent", "generation", "tool"]
TraceStatus = Literal["working", "input-required", "completed", "failed", "cancelled"]


def trace_metadata(
    trace_kind: TraceKind,
    *,
    turn_id: str,
    session_id: str,
    service: str | None = None,
    environment: str | None = None,
    **fields: Any,
) -> dict[str, Any]:
    """Build the canonical ``trace.v1`` metadata envelope."""
    return {
        **fields,
        "schemaVersion": TRACE_SCHEMA_VERSION,
        "traceKind": trace_kind,
        "service": service or "ai37-agent-host",
        "environment": environment
        or os.environ.get("LANGFUSE_TRACING_ENVIRONMENT")
        or os.environ.get("NODE_ENV")
        or "development",
        "turnId": turn_id,
        "sessionId": session_id,
    }
