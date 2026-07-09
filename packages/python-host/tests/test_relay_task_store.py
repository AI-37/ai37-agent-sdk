"""Тесты InMemoryRemoteTaskStore (resume childTaskId по parentContextId+agentId)."""

from ai37_agent_host.relay import InMemoryRemoteTaskStore


async def test_set_get_clear_roundtrip():
    store = InMemoryRemoteTaskStore()
    assert await store.get("ctx1", "minstroy") is None

    await store.set("ctx1", "minstroy", "task-42", "input-required")
    ref = await store.get("ctx1", "minstroy")
    assert ref is not None
    assert (ref.task_id, ref.state) == ("task-42", "input-required")

    await store.clear("ctx1", "minstroy")
    assert await store.get("ctx1", "minstroy") is None


async def test_scoped_by_context_and_agent():
    store = InMemoryRemoteTaskStore()
    await store.set("ctx1", "a", "t-a", "completed")
    await store.set("ctx1", "b", "t-b", "completed")
    await store.set("ctx2", "a", "t-a2", "completed")
    assert (await store.get("ctx1", "a")).task_id == "t-a"
    assert (await store.get("ctx1", "b")).task_id == "t-b"
    assert (await store.get("ctx2", "a")).task_id == "t-a2"
