"""Тесты RedisTaskStore (durable A2A TaskStore на Redis).

Redis подменяется fakeredis.aioredis.FakeRedis (API-совместимый асинхронный in-memory).
Проверяем: protobuf-roundtrip, owner-scoping, list-фильтры/сортировку/пагинацию,
самоочистку отставшего индекса. Логика list зеркалит upstream InMemoryTaskStore.
"""

from __future__ import annotations

import pytest
from a2a.auth.user import User
from a2a.server.context import ServerCallContext
from a2a.types import a2a_pb2
from a2a.utils.errors import InvalidParamsError

from ai37_agent_host.redis_task_store import RedisTaskStore

fakeredis = pytest.importorskip("fakeredis")


class _FakeUser(User):
    def __init__(self, name: str) -> None:
        self._name = name

    @property
    def is_authenticated(self) -> bool:
        return True

    @property
    def user_name(self) -> str:
        return self._name


def _ctx(owner: str) -> ServerCallContext:
    return ServerCallContext(user=_FakeUser(owner))


def _task(
    task_id: str, *, context_id: str = "ctx", state=None, ts: str | None = None
) -> a2a_pb2.Task:
    task = a2a_pb2.Task(id=task_id, context_id=context_id)
    if state is not None:
        task.status.state = state
    if ts is not None:
        task.status.timestamp.FromJsonString(ts)
    return task


@pytest.fixture
def store() -> RedisTaskStore:
    client = fakeredis.aioredis.FakeRedis()
    return RedisTaskStore(client, prefix="test:tasks:")


# ── roundtrip / get / delete ──────────────────────────────────────────────────
async def test_save_get_roundtrip(store: RedisTaskStore) -> None:
    ctx = _ctx("alice")
    task = _task("t1", context_id="c1", state=a2a_pb2.TASK_STATE_WORKING, ts="2026-01-01T00:00:00Z")
    await store.save(task, ctx)
    got = await store.get("t1", ctx)
    assert got is not None
    assert got.id == "t1"
    assert got.context_id == "c1"
    assert got.status.state == a2a_pb2.TASK_STATE_WORKING


async def test_get_missing_returns_none(store: RedisTaskStore) -> None:
    assert await store.get("nope", _ctx("alice")) is None


async def test_delete_removes_task_and_index(store: RedisTaskStore) -> None:
    ctx = _ctx("alice")
    await store.save(_task("t1"), ctx)
    await store.delete("t1", ctx)
    assert await store.get("t1", ctx) is None
    # индекс тоже вычищен → list пуст
    resp = await store.list(a2a_pb2.ListTasksRequest(), ctx)
    assert resp.total_size == 0


async def test_delete_missing_is_noop(store: RedisTaskStore) -> None:
    await store.delete("ghost", _ctx("alice"))  # не должно бросать


# ── owner-scoping ─────────────────────────────────────────────────────────────
async def test_owner_scoping_isolates_tasks(store: RedisTaskStore) -> None:
    await store.save(_task("t1"), _ctx("alice"))
    await store.save(_task("t2"), _ctx("bob"))
    # bob не видит таск alice
    assert await store.get("t1", _ctx("bob")) is None
    assert await store.get("t1", _ctx("alice")) is not None
    alice_list = await store.list(a2a_pb2.ListTasksRequest(), _ctx("alice"))
    assert [t.id for t in alice_list.tasks] == ["t1"]


# ── list: фильтры ─────────────────────────────────────────────────────────────
async def test_list_filters_by_context_id(store: RedisTaskStore) -> None:
    ctx = _ctx("alice")
    await store.save(_task("t1", context_id="A"), ctx)
    await store.save(_task("t2", context_id="B"), ctx)
    resp = await store.list(a2a_pb2.ListTasksRequest(context_id="A"), ctx)
    assert [t.id for t in resp.tasks] == ["t1"]


async def test_list_filters_by_status(store: RedisTaskStore) -> None:
    ctx = _ctx("alice")
    await store.save(_task("t1", state=a2a_pb2.TASK_STATE_WORKING), ctx)
    await store.save(_task("t2", state=a2a_pb2.TASK_STATE_COMPLETED), ctx)
    resp = await store.list(
        a2a_pb2.ListTasksRequest(status=a2a_pb2.TASK_STATE_COMPLETED), ctx
    )
    assert [t.id for t in resp.tasks] == ["t2"]


async def test_list_filters_by_timestamp_after(store: RedisTaskStore) -> None:
    ctx = _ctx("alice")
    await store.save(_task("old", ts="2026-01-01T00:00:00Z"), ctx)
    await store.save(_task("new", ts="2026-06-01T00:00:00Z"), ctx)
    req = a2a_pb2.ListTasksRequest()
    req.status_timestamp_after.FromJsonString("2026-03-01T00:00:00Z")
    resp = await store.list(req, ctx)
    assert [t.id for t in resp.tasks] == ["new"]


# ── list: сортировка + пагинация ──────────────────────────────────────────────
async def test_list_sorts_by_timestamp_desc(store: RedisTaskStore) -> None:
    ctx = _ctx("alice")
    await store.save(_task("a", ts="2026-01-01T00:00:00Z"), ctx)
    await store.save(_task("b", ts="2026-03-01T00:00:00Z"), ctx)
    await store.save(_task("c", ts="2026-02-01T00:00:00Z"), ctx)
    resp = await store.list(a2a_pb2.ListTasksRequest(), ctx)
    assert [t.id for t in resp.tasks] == ["b", "c", "a"]


async def test_list_pagination_next_page_token(store: RedisTaskStore) -> None:
    ctx = _ctx("alice")
    for i in range(5):
        await store.save(_task(f"t{i}", ts=f"2026-01-0{i + 1}T00:00:00Z"), ctx)
    page1 = await store.list(a2a_pb2.ListTasksRequest(page_size=2), ctx)
    assert page1.total_size == 5
    assert len(page1.tasks) == 2
    assert page1.next_page_token
    # вторая страница по токену
    page2 = await store.list(
        a2a_pb2.ListTasksRequest(page_size=2, page_token=page1.next_page_token), ctx
    )
    assert len(page2.tasks) == 2
    # страницы не пересекаются
    assert not ({t.id for t in page1.tasks} & {t.id for t in page2.tasks})


async def test_list_invalid_page_token_raises(store: RedisTaskStore) -> None:
    ctx = _ctx("alice")
    await store.save(_task("t1"), ctx)
    from a2a.utils.task import encode_page_token

    bad = encode_page_token("does-not-exist")
    with pytest.raises(InvalidParamsError):
        await store.list(a2a_pb2.ListTasksRequest(page_token=bad), ctx)


# ── самоочистка отставшего индекса ────────────────────────────────────────────
async def test_list_cleans_stale_index_entries(store: RedisTaskStore) -> None:
    ctx = _ctx("alice")
    await store.save(_task("t1"), ctx)
    await store.save(_task("t2"), ctx)
    # эмулируем истёкший TTL: удаляем сам ключ таска, оставив id в индексе
    await store._redis.delete("test:tasks:alice:t1")
    resp = await store.list(a2a_pb2.ListTasksRequest(), ctx)
    assert [t.id for t in resp.tasks] == ["t2"]
    # индекс овнера подчищен от битого id
    raw_members = await store._redis.smembers("test:tasks:alice:__index__")
    members = {m.decode() if isinstance(m, bytes) else m for m in raw_members}
    assert members == {"t2"}


# ── дефолтный owner_resolver (resolve_user_scope) ─────────────────────────────
async def test_default_owner_resolver_uses_user_name(store: RedisTaskStore) -> None:
    # resolve_user_scope(ctx) == ctx.user.user_name — save/get согласованы по овнеру
    await store.save(_task("t1"), _ctx("carol"))
    assert await store.get("t1", _ctx("carol")) is not None
    assert await store.get("t1", _ctx("dave")) is None
