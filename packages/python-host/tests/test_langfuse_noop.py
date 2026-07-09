"""Langfuse-трассировка при отсутствии пакетов/ключей — полный no-op (не роняет ход)."""

from ai37_agent_host.observability import (
    BeginTurnArgs,
    inject_trace_context,
    is_langfuse_enabled,
    with_turn_observability,
)
from ai37_agent_host.types import Ai37Metadata


def test_disabled_without_packages():
    # langfuse/opentelemetry не установлены в host-env → трассировка выключена.
    assert is_langfuse_enabled() is False
    assert inject_trace_context() == {}


async def test_with_turn_runs_body_when_disabled():
    calls = []

    async def run():
        calls.append("ran")
        return {"status": "completed"}

    args = BeginTurnArgs(context_id="ctx1", task_id="t1", metadata=Ai37Metadata(channel="chat"))
    result = await with_turn_observability(args, run, lambda r: {"status": r["status"]})
    assert result == {"status": "completed"}
    assert calls == ["ran"]


async def test_with_turn_propagates_exceptions():
    async def run():
        raise ValueError("boom")

    args = BeginTurnArgs(context_id="ctx1", task_id="t1", metadata=Ai37Metadata())
    try:
        await with_turn_observability(args, run)
        raise AssertionError("должно было пробросить")
    except ValueError as exc:
        assert str(exc) == "boom"
