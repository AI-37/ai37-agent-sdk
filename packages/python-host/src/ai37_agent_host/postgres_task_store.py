"""PostgresTaskStore — durable A2A ``TaskStore`` на Postgres поверх upstream ``DatabaseTaskStore``.

Своё хранилище не пишем: ``a2a-sdk`` 1.x уже несёт ``DatabaseTaskStore`` (SQLAlchemy async,
protobuf-сериализация, owner-scoped ``get``/``list``/``delete``). Здесь только то, чего в нём нет:

* **Владелец** — upstream ``resolve_user_scope``: хост кладёт в ``ServerCallContext``
  пользователя из JWT хода (``owner.py``, ``<org_id>:<sub>``) на A2A- и AG-UI-пути.
* **Чужую задачу не перезаписать.** Upstream ``save`` делает ``merge`` по одному ``id``: запись
  того же id от другого владельца молча забирает задачу себе. Здесь такой ``save`` бросает
  ``TaskOwnerError``.
* **Завершённую задачу не перезаписать** (completed/failed/canceled/rejected): поздний или
  повторный save игнорируется, при смене состояния — warning.
* **Схема — шагом деплоя, не подом.** ``migrate_postgres_task_store`` создаёт таблицу из Job;
  стор работает с ``create_table=False`` и проверяет её в ``assert_ready``.
* **id длиннее 36 символов.** Upstream объявляет ``id``/``context_id`` как ``String(36)``, а
  ``contextId`` тредов chat-backend — ``th_<uuid>`` (39). Миграция расширяет обе колонки до
  ``varchar(255)`` (SQLAlchemy длину при вставке не проверяет), ``assert_ready`` это проверяет,
  а ещё более длинный id отклоняется как ``InvalidParams``, а не 500 от БД.
* **Ретенция** ``cleanup``: завершённые задачи старше N дней, брошенные паузы — только по явному
  порогу.

Нужен extra ``postgres`` (``sqlalchemy[asyncio]`` + ``asyncpg``): ``pip install
ai37-agent-host[postgres]``. CLI для Helm-хука и CronJob::

    DATABASE_URL=postgres://... python -m ai37_agent_host.postgres_task_store migrate
    DATABASE_URL=... python -m ai37_agent_host.postgres_task_store cleanup --terminal-days 7
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from a2a.server.context import ServerCallContext
from a2a.server.owner_resolver import OwnerResolver, resolve_user_scope
from a2a.server.tasks.database_task_store import DatabaseTaskStore
from a2a.types.a2a_pb2 import Task, TaskState

if TYPE_CHECKING:  # pragma: no cover - sqlalchemy приходит extra'ом
    from sqlalchemy.ext.asyncio import AsyncEngine

logger = logging.getLogger(__name__)

#: Таблица по умолчанию. Не ``tasks`` (дефолт upstream): у агента в той же БД бывают свои таблицы.
DEFAULT_TABLE_NAME = "a2a_tasks"

#: Ширина ``id``/``context_id`` после миграции. Upstream — 36, наши ``th_<uuid>`` — 39.
MAX_ID_LENGTH = 255

#: Состояния, из которых A2A-задача уже не выходит.
TERMINAL_TASK_STATES: frozenset[int] = frozenset(
    {
        TaskState.TASK_STATE_COMPLETED,
        TaskState.TASK_STATE_FAILED,
        TaskState.TASK_STATE_CANCELED,
        TaskState.TASK_STATE_REJECTED,
    }
)


_TASK_MODELS: dict[str, type] = {}


def _task_model(table_name: str) -> type:
    """ORM-модель таблицы, одна на процесс.

    Upstream ``create_task_model`` при каждом вызове регистрирует новый класс в общем
    ``Base.metadata``, и второй ``DatabaseTaskStore`` на ту же таблицу падает
    («Table ... is already defined»). Кешируем модель по имени таблицы.
    """
    from a2a.server.models import TaskModel, create_task_model

    if table_name == "tasks":
        return TaskModel
    if table_name not in _TASK_MODELS:
        _TASK_MODELS[table_name] = create_task_model(table_name)
    return _TASK_MODELS[table_name]


class TaskOwnerError(PermissionError):
    """Попытка записать задачу, которая принадлежит другому владельцу."""

    def __init__(self, task_id: str) -> None:
        super().__init__(f"PostgresTaskStore: task {task_id} belongs to another owner")


@dataclass(frozen=True)
class CleanupResult:
    terminal_deleted: int
    stale_deleted: int


def to_async_url(database_url: str) -> str:
    """``postgres://``/``postgresql://`` из terraform-секрета → драйвер asyncpg для SQLAlchemy."""
    for prefix in ("postgresql+asyncpg://", "postgres://", "postgresql://"):
        if database_url.startswith(prefix):
            return "postgresql+asyncpg://" + database_url[len(prefix) :]
    return database_url


def create_engine(database_url: str, *, pool_size: int = 5) -> AsyncEngine:
    from sqlalchemy.ext.asyncio import create_async_engine

    url = to_async_url(database_url)
    if url.startswith("postgresql+asyncpg://"):
        return create_async_engine(url, pool_size=pool_size, pool_pre_ping=True)
    return create_async_engine(url)  # sqlite+aiosqlite и прочее — для тестов/локали


class PostgresTaskStore(DatabaseTaskStore):
    """``DatabaseTaskStore`` с владельцем из JWT, защитой чужих/завершённых задач и ретенцией."""

    def __init__(
        self,
        engine: AsyncEngine,
        *,
        table_name: str = DEFAULT_TABLE_NAME,
        owner_resolver: OwnerResolver = resolve_user_scope,
    ) -> None:
        # Без table_name: upstream не создаёт модель заново, ниже подставляем кешированную.
        super().__init__(engine, create_table=False, owner_resolver=owner_resolver)
        self.task_model = _task_model(table_name)
        self.table_name = table_name

    async def assert_ready(self) -> None:
        """Падает, если таблицы нет: миграция не прогнана (под не должен стартовать)."""
        from sqlalchemy import inspect

        async with self.engine.connect() as conn:
            exists = await conn.run_sync(
                lambda sync_conn: inspect(sync_conn).has_table(self.table_name)
            )
        if not exists:
            raise RuntimeError(
                f"PostgresTaskStore: table {self.table_name} not found. "
                "Run `python -m ai37_agent_host.postgres_task_store migrate` first."
            )
        widths = await _id_column_widths(self.engine, self.table_name)
        narrow = {name: width for name, width in widths.items() if width < MAX_ID_LENGTH}
        if narrow:
            raise RuntimeError(
                f"PostgresTaskStore: {self.table_name} id columns too narrow {narrow}, "
                f"expected {MAX_ID_LENGTH}. Run `python -m ai37_agent_host.postgres_task_store "
                "migrate` first."
            )

    async def _stored(self, task_id: str) -> tuple[str | None, int] | None:
        """``(owner, state)`` сохранённой задачи без owner-фильтра, или ``None``."""
        from sqlalchemy import select

        model = self.task_model
        async with self.async_session_maker() as session:
            row = (
                await session.execute(select(model.owner, model.status).where(model.id == task_id))
            ).first()
        if row is None:
            return None
        status = row.status or {}
        state_name = status.get("state", "TASK_STATE_UNSPECIFIED")
        return row.owner, TaskState.Value(state_name)

    async def save(self, task: Task, context: ServerCallContext) -> None:
        _check_id_length(task)
        owner = self.owner_resolver(context)
        stored = await self._stored(task.id)
        if stored is not None:
            stored_owner, stored_state = stored
            if stored_owner != owner:
                raise TaskOwnerError(task.id)
            if stored_state in TERMINAL_TASK_STATES:
                if stored_state != task.status.state:
                    logger.warning(
                        "PostgresTaskStore: task %s is already %s; ignored update to %s",
                        task.id,
                        TaskState.Name(stored_state),
                        TaskState.Name(task.status.state),
                    )
                return
        await super().save(task, context)

    async def cleanup(
        self,
        *,
        terminal_retention_days: int,
        stale_retention_days: int | None = None,
        batch_size: int = 1000,
    ) -> CleanupResult:
        """Ретенция батчами; паузы HITL — только при явном ``stale_retention_days``.

        Возраст считается по ``last_updated`` (timestamp статуса задачи), строки без него не
        трогаем.
        """
        if stale_retention_days is not None and stale_retention_days < terminal_retention_days:
            raise ValueError("stale_retention_days must be >= terminal_retention_days")
        terminal_names = [TaskState.Name(s) for s in TERMINAL_TASK_STATES]
        state = self.task_model.status["state"].as_string()
        terminal_deleted = await self._delete_in_batches(
            state.in_(terminal_names), terminal_retention_days, batch_size
        )
        stale_deleted = 0
        if stale_retention_days is not None:
            stale_deleted = await self._delete_in_batches(
                state.not_in(terminal_names), stale_retention_days, batch_size
            )
        return CleanupResult(terminal_deleted, stale_deleted)

    async def _delete_in_batches(self, state_filter: Any, days: int, batch_size: int) -> int:
        from sqlalchemy import delete, select

        model = self.task_model
        # last_updated у upstream — TIMESTAMP без зоны, naive UTC (Timestamp.ToDatetime()).
        cutoff = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=days)
        total = 0
        while True:
            ids = (
                select(model.id)
                .where(state_filter, model.last_updated < cutoff)
                .limit(batch_size)
                .scalar_subquery()
            )
            async with self.async_session_maker.begin() as session:
                result: Any = await session.execute(delete(model).where(model.id.in_(ids)))
            deleted = result.rowcount or 0
            total += deleted
            if deleted < batch_size:
                return total


def _check_id_length(task: Task) -> None:
    """id приходит от клиента (AG-UI threadId, A2A contextId): длинный — ошибка запроса, не 500."""
    from a2a.utils.errors import InvalidParamsError

    for name, value in (("id", task.id), ("contextId", task.context_id)):
        if len(value) > MAX_ID_LENGTH:
            raise InvalidParamsError(f"task {name} is longer than {MAX_ID_LENGTH} characters")


async def _id_column_widths(engine: AsyncEngine, table_name: str) -> dict[str, int]:
    """Ширина varchar у ``id``/``context_id`` в Postgres; у прочих СУБД длина не проверяется."""
    if engine.dialect.name != "postgresql":
        return {}
    from sqlalchemy import text

    async with engine.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT column_name, character_maximum_length FROM information_schema.columns "
                "WHERE table_name = :t AND column_name IN ('id', 'context_id') "
                "AND table_schema = current_schema()"
            ),
            {"t": table_name},
        )
        return {row[0]: row[1] or MAX_ID_LENGTH for row in rows}


async def migrate_postgres_task_store(
    engine: AsyncEngine, *, table_name: str = DEFAULT_TABLE_NAME
) -> None:
    """Создаёт таблицу задач и расширяет id-колонки (идемпотентно). Запускать из Job до выката.

    Дальнейшие изменения схемы upstream выпускает Alembic-миграциями (``a2a-db upgrade``
    из ``a2a-sdk[db-cli]`` с ``--tasks-table``); ширину id они не трогают.
    """
    from a2a.server.models import Base
    from sqlalchemy import text

    model: Any = _task_model(table_name)
    table = model.__table__
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all, tables=[table])
        if engine.dialect.name == "postgresql":
            quoted = engine.dialect.identifier_preparer.quote(table_name)
            await conn.execute(
                text(
                    f"ALTER TABLE {quoted} "
                    f"ALTER COLUMN id TYPE varchar({MAX_ID_LENGTH}), "
                    f"ALTER COLUMN context_id TYPE varchar({MAX_ID_LENGTH})"
                )
            )


async def _run_cli(args: argparse.Namespace, database_url: str) -> str:
    engine = create_engine(database_url, pool_size=1)
    try:
        if args.command == "migrate":
            await migrate_postgres_task_store(engine, table_name=args.table)
            return f"ai37 task store: table {args.table} ready"
        store = PostgresTaskStore(engine, table_name=args.table)
        await store.assert_ready()
        result = await store.cleanup(
            terminal_retention_days=args.terminal_days,
            stale_retention_days=args.stale_days,
            batch_size=args.batch_size,
        )
        return (
            f"ai37 task store: deleted {result.terminal_deleted} terminal, "
            f"{result.stale_deleted} stale tasks"
        )
    finally:
        await engine.dispose()


def main(argv: Sequence[str] | None = None, env: dict[str, str] | None = None) -> int:
    """CLI ``migrate | cleanup``. Строка подключения — только из ``DATABASE_URL``."""
    parser = argparse.ArgumentParser(prog="python -m ai37_agent_host.postgres_task_store")
    parser.add_argument("--table", default=DEFAULT_TABLE_NAME)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("migrate", help="создать таблицу задач")
    cleanup = sub.add_parser("cleanup", help="удалить устаревшие задачи")
    cleanup.add_argument("--terminal-days", type=int, required=True)
    cleanup.add_argument("--stale-days", type=int, default=None)
    cleanup.add_argument("--batch-size", type=int, default=1000)
    args = parser.parse_args(argv)

    database_url = (env if env is not None else os.environ).get("DATABASE_URL")
    if not database_url:
        print("ai37 task store: DATABASE_URL is not set", file=sys.stderr)
        return 1
    print(asyncio.run(_run_cli(args, database_url)))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
