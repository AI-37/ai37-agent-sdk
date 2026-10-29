"""Turn-спан Langfuse на A2A-ходе, атрибуты без None и фоновый flush.

Регрессии из AI-37/polimetrika-data-agent#8.

Подменный клиент проверяет проводку executor'а, настоящий клиент langfuse v5 (dev-зависимость) —
место turn-спана в трейсе оркестратора и тишину ``propagate_attributes``. Экспорт настоящего
клиента уходит в локальную заглушку OTLP, наружу тесты не ходят.
"""

import asyncio
import gzip
import logging
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from typing import Any

import langfuse
import pytest
from a2a.server.context import ServerCallContext
from a2a.server.request_handlers import DefaultRequestHandlerV2
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import (
    AgentCapabilities,
    AgentCard,
    AgentInterface,
    Message,
    SendMessageRequest,
)
from google.protobuf.json_format import ParseDict
from opentelemetry import trace
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

import ai37_agent_host.observability.langfuse as lf
from ai37_agent_host.a2a_executor import HostExecutor
from ai37_agent_host.als import (
    HostScope,
    current_langfuse_callbacks,
    current_trace_id,
    scope_context,
)
from ai37_agent_host.types import AgentRequest, AgentResult

TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
TRACEPARENT = f"00-{TRACE_ID}-b7ad6b7169203331-01"
FRONT_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"


class _FakeSpan:
    def __init__(self) -> None:
        self.updates: list[dict[str, Any]] = []

    def update(self, **kwargs: Any) -> None:
        self.updates.append(kwargs)


class _FakeClient:
    """Клиент Langfuse без сети: запоминает спаны хода и активный trace id OTel на их входе."""

    def __init__(self, flush_delay_s: float = 0.0, flush_error: Exception | None = None) -> None:
        self.observations: list[dict[str, Any]] = []
        self.flush_calls = 0
        self.flush_done = threading.Event()
        self._flush_delay_s = flush_delay_s
        self._flush_error = flush_error

    @contextmanager
    def start_as_current_observation(
        self, *, name: str, trace_context: dict[str, str] | None = None
    ) -> Iterator[_FakeSpan]:
        span = _FakeSpan()
        active = trace.get_current_span().get_span_context()
        self.observations.append(
            {
                "name": name,
                "trace_context": trace_context,
                "parent_trace_id": f"{active.trace_id:032x}" if active.is_valid else None,
                "span": span,
            }
        )
        yield span

    def get_current_trace_id(self) -> str:
        return "f" * 32

    def flush(self) -> None:
        self.flush_calls += 1
        try:
            time.sleep(self._flush_delay_s)
            if self._flush_error is not None:
                raise self._flush_error
        finally:
            self.flush_done.set()


class _RecordingHandler:
    """Хендлер агента: запоминает, что когниция видит из ALS на время хода."""

    def __init__(self) -> None:
        self.callbacks: list[Any] | None = None
        self.trace_id: str | None = None

    async def run(self, req: AgentRequest) -> AgentResult:
        self.callbacks = current_langfuse_callbacks()
        self.trace_id = current_trace_id()
        return AgentResult(status="completed", message="готово")


class _FakeQueue:
    def __init__(self) -> None:
        self.events: list[Any] = []

    async def enqueue_event(self, event: Any) -> None:
        self.events.append(event)


@pytest.fixture
def lf_state(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Чистый singleton клиента и потока flush на тест; поток flush дожидаемся в конце."""
    monkeypatch.setattr(lf, "_client", lf._UNSET)
    monkeypatch.setattr(lf, "_flush_thread", None)
    yield
    if lf._flush_thread is not None:
        lf._flush_thread.join(timeout=5)


def _use_client(monkeypatch: pytest.MonkeyPatch, client: Any, handler: Any = None) -> None:
    monkeypatch.setattr(lf, "_client", client)
    monkeypatch.setattr(lf, "_make_callback_handler", lambda: handler)


async def _execute(
    handler: Any,
    *,
    metadata: dict[str, Any] | None = None,
    service: str = "data-agent",
) -> list[Any]:
    payload: dict[str, Any] = {"role": "ROLE_USER", "parts": [{"text": "сводка по объекту"}]}
    if metadata is not None:
        payload["metadata"] = metadata
    rc = SimpleNamespace(
        message=ParseDict(payload, Message(), ignore_unknown_fields=True),
        task_id="t1",
        context_id="c1",
        configuration=None,
        current_task=None,
    )
    ctx = SimpleNamespace(claims=SimpleNamespace(sub="user-1"), billing_org_id="org-1")
    queue = _FakeQueue()
    with scope_context(HostScope(ctx=ctx)):
        await HostExecutor(handler, agent_text_modes=["text/plain"], service=service).execute(
            rc, queue
        )
    return queue.events


# ───────────────────────── turn-спан на A2A ─────────────────────────


async def test_a2a_turn_opens_span_and_gives_callbacks(monkeypatch, lf_state):
    client = _FakeClient()
    callback = object()
    _use_client(monkeypatch, client, callback)
    agent = _RecordingHandler()

    await _execute(agent)

    assert agent.callbacks == [callback]
    assert agent.trace_id == "f" * 32
    [observation] = client.observations
    assert observation["name"] == "data-agent:a2a"
    final = observation["span"].updates[-1]["metadata"]
    assert final["status"] == "completed"
    assert final["turnId"] == "t1" and final["contextId"] == "c1"
    assert {"output": {"status": "completed", "message": "готово"}} in observation["span"].updates


async def test_a2a_turn_propagates_session_and_user(monkeypatch, lf_state):
    _use_client(monkeypatch, _FakeClient())
    calls: list[dict[str, Any]] = []

    @contextmanager
    def fake_propagate(**kwargs: Any) -> Iterator[None]:
        calls.append(kwargs)
        yield

    monkeypatch.setattr(langfuse, "propagate_attributes", fake_propagate)

    await _execute(_RecordingHandler(), metadata={"ai37": {"channel": "chat"}})

    [kwargs] = calls
    assert kwargs["session_id"] == "c1"
    assert kwargs["user_id"] == "user-1"
    assert kwargs["tags"] == ["chat"]
    assert kwargs["metadata"]["billing_org_id"] == "org-1"


async def test_a2a_turn_inherits_incoming_traceparent(monkeypatch, lf_state):
    client = _FakeClient()
    _use_client(monkeypatch, client)

    await _execute(_RecordingHandler(), metadata={"traceparent": TRACEPARENT})

    [observation] = client.observations
    assert observation["parent_trace_id"] == TRACE_ID
    assert observation["trace_context"] is None
    # После хода родительский контекст снят: ход не протекает в чужой трейс.
    assert not trace.get_current_span().get_span_context().is_valid


async def test_a2a_turn_falls_back_to_front_trace_id(monkeypatch, lf_state):
    client = _FakeClient()
    _use_client(monkeypatch, client)

    await _execute(_RecordingHandler(), metadata={"ai37": {"trace_id": FRONT_TRACE_ID.upper()}})

    [observation] = client.observations
    assert observation["trace_context"] == {"trace_id": FRONT_TRACE_ID}
    assert observation["parent_trace_id"] is None


# ───────────────────────── propagate_attributes без None ─────────────────────────


async def test_unset_fields_never_reach_propagate_attributes(monkeypatch, lf_state):
    _use_client(monkeypatch, _FakeClient())
    calls: list[dict[str, Any]] = []

    @contextmanager
    def fake_propagate(**kwargs: Any) -> Iterator[None]:
        calls.append(kwargs)
        yield

    monkeypatch.setattr(langfuse, "propagate_attributes", fake_propagate)
    args = lf.BeginTurnArgs(context_id="", task_id="t1", metadata=lf.Ai37Metadata())

    async def run() -> str:
        return "ok"

    await lf.with_turn_observability(args, run)

    [kwargs] = calls
    # Нет диалога, пользователя и тегов — ключей нет вовсе; в metadata только заданные поля.
    assert set(kwargs) == {"metadata"}
    assert None not in kwargs["metadata"].values()
    assert {"intent", "channel", "app_id", "billing_org_id", "tenant"}.isdisjoint(
        kwargs["metadata"]
    )


# ───────────────────────── flush не блокирует ход ─────────────────────────


async def test_slow_flush_does_not_delay_turn_or_event_loop(monkeypatch, lf_state):
    client = _FakeClient(flush_delay_s=1.0)
    _use_client(monkeypatch, client)
    ticks = 0

    async def ticker() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    ticking = asyncio.create_task(ticker())
    started = time.monotonic()
    await _execute(_RecordingHandler())
    elapsed = time.monotonic() - started
    await asyncio.sleep(0.2)  # flush ещё идёт — loop живой
    ticking.cancel()

    assert elapsed < 0.5
    assert client.flush_calls == 1 and not client.flush_done.is_set()
    assert ticks >= 10


async def test_flush_in_progress_is_not_started_again(monkeypatch, lf_state):
    client = _FakeClient(flush_delay_s=0.5)
    _use_client(monkeypatch, client)

    await _execute(_RecordingHandler())
    await _execute(_RecordingHandler())

    assert lf._flush_thread is not None
    lf._flush_thread.join(timeout=5)
    assert client.flush_calls == 1


async def test_flush_error_does_not_fail_turn(monkeypatch, lf_state, caplog):
    client = _FakeClient(flush_error=RuntimeError("langfuse недоступен"))
    _use_client(monkeypatch, client)
    agent = _RecordingHandler()

    with caplog.at_level(logging.WARNING, logger=lf.__name__):
        events = await _execute(agent)
        assert lf._flush_thread is not None
        lf._flush_thread.join(timeout=5)

    assert agent.callbacks == []  # CallbackHandler не создался — ход всё равно идёт
    assert "TASK_STATE_COMPLETED" in str(events[-1])
    assert "Langfuse flush не удался: langfuse недоступен" in caplog.text


# ───────────────────────── без ключей / без пакета — no-op ─────────────────────────


async def test_a2a_turn_without_keys_is_noop(monkeypatch, lf_state):
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    agent = _RecordingHandler()

    events = await _execute(agent)

    assert agent.callbacks == [] and agent.trace_id is None
    assert "TASK_STATE_COMPLETED" in str(events[-1])
    assert lf._flush_thread is None


async def test_a2a_turn_without_package_is_noop(monkeypatch, lf_state):
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-test")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-test")
    monkeypatch.setitem(sys.modules, "langfuse", None)  # import langfuse → ImportError
    agent = _RecordingHandler()

    events = await _execute(agent)

    assert lf._client is None
    assert agent.callbacks == [] and agent.trace_id is None
    assert "TASK_STATE_COMPLETED" in str(events[-1])


# ───────────────────────── настоящий клиент langfuse v5 ─────────────────────────
#
# Ход идёт через настоящий DefaultRequestHandlerV2 a2a-sdk: при установленном OpenTelemetry он
# сам открывает SERVER-спан на запрос, и этот спан в Langfuse не экспортируется. Именно под ним
# turn-спан агента в prod получал несуществующего родителя и отдельный trace (Полиметрика, 29.10).

ORCHESTRATOR_SPAN_ID = "b7ad6b7169203331"


class _OtlpSink(BaseHTTPRequestHandler):
    """Заглушка OTLP/HTTP: копит тела экспорта, отвечает 200."""

    bodies: list[bytes] = []

    def do_POST(self) -> None:  # noqa: N802 - имя метода задаёт http.server
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        if self.path.endswith("/otel/v1/traces"):
            type(self).bodies.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *_args: Any) -> None:
        pass


@pytest.fixture(scope="module")
def otlp_sink() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _OtlpSink)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


@pytest.fixture
def real_langfuse(monkeypatch, lf_state, otlp_sink) -> None:
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-test")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-test")
    monkeypatch.setenv("LANGFUSE_BASE_URL", otlp_sink)
    _OtlpSink.bodies.clear()


def _exported_span(name: str) -> Any:
    """Спан ``name`` из того, что клиент выгрузил в заглушку (ждём фоновый flush хода)."""
    assert lf._flush_thread is not None
    lf._flush_thread.join(timeout=10)
    found = []
    for body in _OtlpSink.bodies:
        request = ExportTraceServiceRequest()
        request.ParseFromString(body)
        for resource_spans in request.resource_spans:
            for scope_spans in resource_spans.scope_spans:
                found += [span for span in scope_spans.spans if span.name == name]
    assert len(found) == 1, [body[:80] for body in _OtlpSink.bodies]
    return found[0]


def _orchestrator_metadata(traceparent: str | None) -> dict[str, Any]:
    """message.metadata в том виде, в каком его собирает relay ts-host (``buildParams``).

    Конверт ai37 без trace_id (оркестратор его вниз не шлёт), W3C trace-context от
    ``injectTraceContext`` — плоскими ключами рядом с ним.
    """
    metadata: dict[str, Any] = {
        "a2uiClientCapabilities": {"v0.9": {"supportedCatalogIds": ["ai37/catalog@1"]}},
        "ai37": {"context_refs": ["monitoring:project:42"]},
    }
    if traceparent is not None:
        metadata["traceparent"] = traceparent
    return metadata


async def _send_via_a2a_sdk(agent: Any, metadata: dict[str, Any]) -> None:
    request_handler = DefaultRequestHandlerV2(
        agent_executor=HostExecutor(agent, agent_text_modes=["text/plain"], service="data-agent"),
        task_store=InMemoryTaskStore(),
        agent_card=AgentCard(
            name="data-agent",
            description="test",
            version="0.0.0",
            supported_interfaces=[
                AgentInterface(url="http://local/a2a", protocol_binding="JSONRPC")
            ],
            capabilities=AgentCapabilities(streaming=True),
            default_input_modes=["text/plain"],
            default_output_modes=["text/plain"],
        ),
    )
    message = ParseDict(
        {
            "message_id": "m1",
            "role": "ROLE_USER",
            "parts": [{"text": "сводка по объекту"}],
            "metadata": metadata,
        },
        Message(),
    )
    ctx = SimpleNamespace(claims=SimpleNamespace(sub="user-1"), billing_org_id="org-1")
    with scope_context(HostScope(ctx=ctx)):
        await request_handler.on_message_send(
            SendMessageRequest(message=message), ServerCallContext(state={})
        )


async def test_real_turn_continues_orchestrator_trace(real_langfuse, caplog):
    agent = _RecordingHandler()

    with caplog.at_level(logging.WARNING):
        # Ни intent, ни channel, ни tenant — раньше это давало WARNING на каждое поле.
        await _send_via_a2a_sdk(agent, _orchestrator_metadata(TRACEPARENT))
        span = _exported_span("data-agent:a2a")

    assert agent.trace_id == TRACE_ID
    assert span.trace_id.hex() == TRACE_ID
    # Родитель — спан `remote-a2a:<agent>` оркестратора из traceparent, а не спан a2a-sdk.
    assert span.parent_span_id.hex() == ORCHESTRATOR_SPAN_ID
    assert "Propagated attribute" not in caplog.text


async def test_real_turn_without_traceparent_is_a_root(real_langfuse):
    agent = _RecordingHandler()

    await _send_via_a2a_sdk(agent, _orchestrator_metadata(None))
    span = _exported_span("data-agent:a2a")

    # Без traceparent и trace_id — новый корень, а не ребёнок неэкспортируемого спана a2a-sdk.
    assert span.parent_span_id == b""
    assert span.trace_id.hex() == agent.trace_id != TRACE_ID
