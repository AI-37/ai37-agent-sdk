"""PostgresTaskStore: владелец из JWT, чужие и завершённые задачи, ретенция, миграция, CLI.

Логика гоняется на SQLite (aiosqlite) всегда и на живом Postgres при ``TEST_DATABASE_URL``.
"""

from __future__ import annotations

import logging
import os
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest

pytest.importorskip("sqlalchemy")

from a2a.server.context import ServerCallContext  # noqa: E402
from a2a.types.a2a_pb2 import Task, TaskState, TaskStatus  # noqa: E402
from google.protobuf.struct_pb2 import Struct  # noqa: E402
from sqlalchemy import text, update  # noqa: E402

from ai37_agent_host.als import HostScope, scope_context  # noqa: E402
from ai37_agent_host.owner import current_call_context  # noqa: E402
from ai37_agent_host.postgres_task_store import (  # noqa: E402
    PostgresTaskStore,
    TaskOwnerError,
    create_engine,
    main,
    migrate_postgres_task_store,
    to_async_url,
)

PG_URL = os.environ.get("TEST_DATABASE_URL")
BACKENDS = ["sqlite"] + (["postgres"] if PG_URL else [])


def _as_user(sub: str, org: str = "org-1") -> Any:
    return scope_context(HostScope(ctx=SimpleNamespace(claims={"sub": sub, "org_id": org})))


def _task(task_id: str, state: int, step: int | None = None) -> Task:
    task = Task(id=task_id, context_id=f"ctx-{task_id}")
    task.status.CopyFrom(TaskStatus(state=state))
    task.status.timestamp.FromDatetime(datetime.now(UTC))
    if step is not None:
        meta = Struct()
        meta.update({"state": {"step": step}})
        task.metadata.CopyFrom(meta)
    return task


def ctx() -> ServerCallContext:
    """Контекст, как его собирает хост: пользователь из JWT текущего хода."""
    return current_call_context()


@pytest.fixture(params=BACKENDS)
async def engine(request: pytest.FixtureRequest, tmp_path: Any) -> AsyncIterator[Any]:
    if request.param == "sqlite":
        eng = create_engine(f"sqlite+aiosqlite:///{tmp_path / 'tasks.db'}")
    else:
        eng = create_engine(PG_URL or "")
    yield eng
    await eng.dispose()


@pytest.fixture
async def table(engine: Any) -> AsyncIterator[str]:
    name = f"t_{uuid.uuid4().hex[:10]}"
    await migrate_postgres_task_store(engine, table_name=name)
    yield name
    async with engine.begin() as conn:
        await conn.execute(text(f"DROP TABLE IF EXISTS {name}"))


@pytest.fixture
def store(engine: Any, table: str) -> PostgresTaskStore:
    return PostgresTaskStore(engine, table_name=table)


# ── url ──────────────────────────────────────────────────────────────────────


def test_async_url_normalisation() -> None:
    assert to_async_url("postgres://u:p@h/db") == "postgresql+asyncpg://u:p@h/db"
    assert to_async_url("postgresql://u:p@h/db") == "postgresql+asyncpg://u:p@h/db"
    assert to_async_url("postgresql+asyncpg://h/db") == "postgresql+asyncpg://h/db"
    assert to_async_url("sqlite+aiosqlite:///x.db") == "sqlite+aiosqlite:///x.db"


# ── schema ───────────────────────────────────────────────────────────────────


async def test_assert_ready_fails_without_migration(engine: Any) -> None:
    store = PostgresTaskStore(engine, table_name=f"missing_{uuid.uuid4().hex[:8]}")
    with pytest.raises(RuntimeError, match="migrate"):
        await store.assert_ready()


async def test_migration_is_idempotent(engine: Any, table: str) -> None:
    await migrate_postgres_task_store(engine, table_name=table)
    await PostgresTaskStore(engine, table_name=table).assert_ready()


# ── save / get ───────────────────────────────────────────────────────────────


async def test_round_trip_survives_a_new_store_instance(
    engine: Any, table: str, store: PostgresTaskStore
) -> None:
    task = _task("t1", TaskState.TASK_STATE_INPUT_REQUIRED, step=2)
    with _as_user("alice"):
        await store.save(task, ctx())
    restarted = PostgresTaskStore(engine, table_name=table)
    with _as_user("alice"):
        loaded = await restarted.get("t1", ctx())
    assert loaded is not None
    assert loaded.status.state == TaskState.TASK_STATE_INPUT_REQUIRED
    assert dict(loaded.metadata)["state"]["step"] == 2


async def test_other_user_cannot_read(store: PostgresTaskStore) -> None:
    with _as_user("alice"):
        await store.save(_task("t2", TaskState.TASK_STATE_WORKING), ctx())
    with _as_user("bob"):
        assert await store.get("t2", ctx()) is None
    with _as_user("alice", org="org-2"):
        assert await store.get("t2", ctx()) is None


async def test_other_user_cannot_overwrite(store: PostgresTaskStore) -> None:
    with _as_user("alice"):
        await store.save(_task("t3", TaskState.TASK_STATE_INPUT_REQUIRED), ctx())
    with _as_user("bob"), pytest.raises(TaskOwnerError):
        await store.save(_task("t3", TaskState.TASK_STATE_WORKING), ctx())
    with _as_user("alice"):
        loaded = await store.get("t3", ctx())
    assert loaded is not None
    assert loaded.status.state == TaskState.TASK_STATE_INPUT_REQUIRED


async def test_non_terminal_task_is_updated(store: PostgresTaskStore) -> None:
    with _as_user("alice"):
        await store.save(_task("t4", TaskState.TASK_STATE_SUBMITTED), ctx())
        await store.save(_task("t4", TaskState.TASK_STATE_INPUT_REQUIRED, step=3), ctx())
        loaded = await store.get("t4", ctx())
    assert loaded is not None
    assert loaded.status.state == TaskState.TASK_STATE_INPUT_REQUIRED


@pytest.mark.parametrize(
    "terminal",
    [
        TaskState.TASK_STATE_COMPLETED,
        TaskState.TASK_STATE_FAILED,
        TaskState.TASK_STATE_CANCELED,
        TaskState.TASK_STATE_REJECTED,
    ],
)
async def test_terminal_task_is_frozen(
    store: PostgresTaskStore, terminal: int, caplog: pytest.LogCaptureFixture
) -> None:
    with _as_user("alice"):
        await store.save(_task("t5", TaskState.TASK_STATE_WORKING), ctx())
        await store.save(_task("t5", terminal), ctx())
        with caplog.at_level(logging.WARNING):
            await store.save(_task("t5", TaskState.TASK_STATE_WORKING), ctx())
        loaded = await store.get("t5", ctx())
    assert loaded is not None
    assert loaded.status.state == terminal
    assert "already" in caplog.text


async def test_repeated_terminal_save_is_silent(
    store: PostgresTaskStore, caplog: pytest.LogCaptureFixture
) -> None:
    with _as_user("alice"):
        await store.save(_task("t6", TaskState.TASK_STATE_COMPLETED), ctx())
        with caplog.at_level(logging.WARNING):
            await store.save(_task("t6", TaskState.TASK_STATE_COMPLETED), ctx())
    assert "already" not in caplog.text


async def test_system_path_without_jwt_keeps_working(store: PostgresTaskStore) -> None:
    await store.save(_task("t7", TaskState.TASK_STATE_WORKING), ctx())
    loaded = await store.get("t7", ctx())
    assert loaded is not None


# ── cleanup ──────────────────────────────────────────────────────────────────


async def _age(store: PostgresTaskStore, task_id: str, days: int) -> None:
    model = store.task_model
    async with store.async_session_maker.begin() as session:
        await session.execute(
            update(model)
            .where(model.id == task_id)
            .values(last_updated=datetime.now(UTC).replace(tzinfo=None) - timedelta(days=days))
        )


async def test_cleanup_keeps_paused_tasks_by_default(store: PostgresTaskStore) -> None:
    await store.save(_task("old-done", TaskState.TASK_STATE_COMPLETED), ctx())
    await store.save(_task("new-done", TaskState.TASK_STATE_FAILED), ctx())
    await store.save(_task("old-paused", TaskState.TASK_STATE_INPUT_REQUIRED), ctx())
    await _age(store, "old-done", 10)
    await _age(store, "old-paused", 100)

    result = await store.cleanup(terminal_retention_days=7)

    assert (result.terminal_deleted, result.stale_deleted) == (1, 0)
    assert await store.get("old-done", ctx()) is None
    assert await store.get("new-done", ctx()) is not None
    assert await store.get("old-paused", ctx()) is not None


async def test_cleanup_stale_when_asked(store: PostgresTaskStore) -> None:
    await store.save(_task("old-paused", TaskState.TASK_STATE_INPUT_REQUIRED), ctx())
    await store.save(_task("fresh-paused", TaskState.TASK_STATE_INPUT_REQUIRED), ctx())
    await _age(store, "old-paused", 40)

    result = await store.cleanup(terminal_retention_days=7, stale_retention_days=30)

    assert (result.terminal_deleted, result.stale_deleted) == (0, 1)
    assert await store.get("fresh-paused", ctx()) is not None


async def test_cleanup_in_small_batches(store: PostgresTaskStore) -> None:
    for i in range(5):
        await store.save(_task(f"done-{i}", TaskState.TASK_STATE_COMPLETED), ctx())
        await _age(store, f"done-{i}", 30)
    result = await store.cleanup(terminal_retention_days=7, batch_size=2)
    assert result.terminal_deleted == 5


async def test_cleanup_rejects_short_stale_window(store: PostgresTaskStore) -> None:
    with pytest.raises(ValueError, match="stale_retention_days"):
        await store.cleanup(terminal_retention_days=30, stale_retention_days=7)


# ── CLI ──────────────────────────────────────────────────────────────────────


def test_cli_migrate_then_cleanup(tmp_path: Any, capsys: pytest.CaptureFixture[str]) -> None:
    env = {"DATABASE_URL": f"sqlite+aiosqlite:///{tmp_path / 'cli.db'}"}
    assert main(["--table", "cli_tasks", "migrate"], env) == 0
    assert (
        main(["--table", "cli_tasks", "cleanup", "--terminal-days", "7", "--stale-days", "30"], env)
        == 0
    )
    out = capsys.readouterr().out.splitlines()
    assert out == [
        "ai37 task store: table cli_tasks ready",
        "ai37 task store: deleted 0 terminal, 0 stale tasks",
    ]


def test_cli_requires_database_url(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["migrate"], {}) == 1
    assert "DATABASE_URL" in capsys.readouterr().err


def test_cli_cleanup_requires_terminal_days() -> None:
    with pytest.raises(SystemExit):
        main(["cleanup"], {"DATABASE_URL": "sqlite+aiosqlite://"})
