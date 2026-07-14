"""RedisTaskStore — durable A2A ``TaskStore`` на Redis (адаптер под ``a2a-sdk`` 1.x protobuf).

Зачем свой адаптер, а не публичный ``a2a-redis``:
    Пакет ``a2a-redis`` на PyPI (последняя 0.2.1) написан под ДО-protobuf эру SDK (0.2.x,
    Pydantic-``Task``) и сериализует через ``model_dump()`` — против protobuf-``Task`` из 1.x
    это падает в рантайме. protobuf-совместимая версия живёт лишь в НЕПРИМЁРЖЕННОМ PR
    redis-developer/a2a-redis#14 (не на PyPI) и тянет обязательный бамп ``a2a-sdk`` → ≥1.1.0
    с breaking changes во всём хосте. Адаптер повторяет ту же protobuf-сериализацию
    (``MessageToDict``/``ParseDict``, как upstream ``DatabaseTaskStore``) и owner-scoped-семантику
    (``resolve_user_scope``, как ``InMemoryTaskStore``), но кладёт в Redis — без бампа SDK и без
    завязки на чужую ветку. Когда ``a2a-redis`` 0.3 выйдет на PyPI — замена тривиальна: тот же
    ``TaskStore``-контракт.

Транспорт/интероп это НЕ затрагивает: ``TaskStore`` — приватная персистентность агента
(его память о собственных задачах для ``tasks/get``/resubscribe/reconcile), она никогда не
попадает «на провод» A2A. Пиры (оркестратор, другие агенты) не видят, какой store внутри.

Redis-клиент (``redis.asyncio.Redis``) ИНЖЕКТИТСЯ потребителем, поэтому ``redis`` — не
runtime-зависимость самого хоста (только опциональный extra + у потребителя). Layout ключей::

    {prefix}{owner}:{task_id}     -> JSON(MessageToDict(task))   # сам таск
    {prefix}{owner}:__index__     -> SET{task_id, ...}           # индекс овнера для list()
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from a2a.server.context import ServerCallContext
from a2a.server.owner_resolver import OwnerResolver, resolve_user_scope
from a2a.server.tasks.task_store import TaskStore
from a2a.types import a2a_pb2
from a2a.types.a2a_pb2 import Task
from a2a.utils.constants import DEFAULT_LIST_TASKS_PAGE_SIZE
from a2a.utils.errors import InvalidParamsError
from a2a.utils.task import decode_page_token, encode_page_token
from google.protobuf.json_format import MessageToDict, ParseDict

if TYPE_CHECKING:  # pragma: no cover - только для типов, redis инжектится извне
    from redis.asyncio import Redis


def _to_str(value: Any) -> str:
    """Redis отдаёт bytes (decode_responses=False) или str (True) — нормализуем в str."""
    if isinstance(value, bytes | bytearray):
        return bytes(value).decode("utf-8")
    return str(value)


class RedisTaskStore(TaskStore):
    """Durable ``TaskStore`` на Redis. Owner-scoped, protobuf-сериализация.

    Зеркалит семантику ``InMemoryTaskStore`` (тот же ``owner_resolver`` по умолчанию,
    те же фильтры/сортировка/пагинация в ``list``), меняя лишь бэкенд на Redis.
    """

    def __init__(
        self,
        redis: Redis,
        *,
        prefix: str = "a2a:tasks:",
        owner_resolver: OwnerResolver = resolve_user_scope,
    ) -> None:
        """``redis``: сконструированный ``redis.asyncio.Redis``. ``prefix``: неймспейс ключей."""
        self._redis = redis
        self._prefix = prefix
        self._owner_resolver = owner_resolver

    def _task_key(self, owner: str, task_id: str) -> str:
        return f"{self._prefix}{owner}:{task_id}"

    def _index_key(self, owner: str) -> str:
        return f"{self._prefix}{owner}:__index__"

    @staticmethod
    def _serialize(task: Task) -> str:
        return json.dumps(MessageToDict(task))

    @staticmethod
    def _deserialize(raw: Any) -> Task:
        return ParseDict(json.loads(_to_str(raw)), Task())

    async def save(self, task: Task, context: ServerCallContext) -> None:
        """Пишет таск + добавляет id в индекс овнера (атомарно, MULTI/EXEC)."""
        owner = self._owner_resolver(context)
        payload = self._serialize(task)
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.set(self._task_key(owner, task.id), payload)
            pipe.sadd(self._index_key(owner), task.id)
            await pipe.execute()

    async def get(self, task_id: str, context: ServerCallContext) -> Task | None:
        """Читает таск овнера по id (или ``None``)."""
        owner = self._owner_resolver(context)
        raw = await self._redis.get(self._task_key(owner, task_id))
        if raw is None:
            return None
        return self._deserialize(raw)

    async def delete(self, task_id: str, context: ServerCallContext) -> None:
        """Удаляет таск + вычищает id из индекса овнера (атомарно)."""
        owner = self._owner_resolver(context)
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.delete(self._task_key(owner, task_id))
            pipe.srem(self._index_key(owner), task_id)
            await pipe.execute()

    async def _load_owner_tasks(self, owner: str) -> list[Task]:
        """Загружает все таски овнера по индексу (пропуская просроченные/битые ключи)."""
        raw_ids = await self._redis.smembers(self._index_key(owner))
        tasks: list[Task] = []
        stale: list[str] = []
        for raw_id in raw_ids:
            task_id = _to_str(raw_id)
            raw = await self._redis.get(self._task_key(owner, task_id))
            if raw is None:
                stale.append(task_id)  # ключ истёк/удалён, а индекс отстал — подчистим
                continue
            tasks.append(self._deserialize(raw))
        if stale:
            await self._redis.srem(self._index_key(owner), *stale)
        return tasks

    async def list(
        self,
        params: a2a_pb2.ListTasksRequest,
        context: ServerCallContext,
    ) -> a2a_pb2.ListTasksResponse:
        """Список тасков овнера — фильтр/сортировка/пагинация как в ``InMemoryTaskStore``."""
        owner = self._owner_resolver(context)
        tasks = await self._load_owner_tasks(owner)

        # Фильтры (зеркало InMemoryTaskStore.list).
        if params.context_id:
            tasks = [t for t in tasks if t.context_id == params.context_id]
        if params.status:
            tasks = [t for t in tasks if t.status.state == params.status]
        if params.HasField("status_timestamp_after"):
            after_iso = params.status_timestamp_after.ToJsonString()
            tasks = [
                t
                for t in tasks
                if (
                    t.HasField("status")
                    and t.status.HasField("timestamp")
                    and t.status.timestamp.ToJsonString() >= after_iso
                )
            ]

        # Сортировка по времени обновления (desc), стабилизация по id.
        tasks.sort(
            key=lambda t: (
                t.status.HasField("timestamp") if t.HasField("status") else False,
                t.status.timestamp.ToJsonString()
                if t.HasField("status") and t.status.HasField("timestamp")
                else "",
                t.id,
            ),
            reverse=True,
        )

        # Пагинация (page_token = id первого элемента страницы).
        total_size = len(tasks)
        start_idx = 0
        if params.page_token:
            start_task_id = decode_page_token(params.page_token)
            valid_token = False
            for i, task in enumerate(tasks):
                if task.id == start_task_id:
                    start_idx = i
                    valid_token = True
                    break
            if not valid_token:
                raise InvalidParamsError(f"Invalid page token: {params.page_token}")
        page_size = params.page_size or DEFAULT_LIST_TASKS_PAGE_SIZE
        end_idx = start_idx + page_size
        next_page_token = encode_page_token(tasks[end_idx].id) if end_idx < total_size else None
        tasks = tasks[start_idx:end_idx]

        return a2a_pb2.ListTasksResponse(
            next_page_token=next_page_token,
            tasks=tasks,
            total_size=total_size,
            page_size=page_size,
        )
