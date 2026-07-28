"""Prometheus-метрики хоста — зеркало ``ts-host/src/metrics.ts`` (те же имена/лейблы, чтобы
Tier-2 алерты были едины для TS- и Python-агентов).

Единый default-REGISTRY (``make_asgi_app()`` в ``create_agent_host`` отдаёт именно его),
ТОЛЬКО низкокардинальные ``ai37_*``-серии (лейблы ограничены service/transport/status/
final_state/reason — никаких per-user / per-context / per-request значений). Скрейпится
внутрикластерным Alloy'ем по ``GET /metrics`` (includeMetrics=``ai37_.*``).

Все инкременты обёрнуты в ``_safe`` и НИКОГДА не бросают — сбой метрик не должен ломать ход.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from prometheus_client import Counter, Histogram

_requests_total = Counter(
    "ai37_agent_requests_total",
    "Total agent turns handled by the host, by transport and outcome (ok|error).",
    ["service", "transport", "status"],
)
_request_duration = Histogram(
    "ai37_agent_request_duration_seconds",
    "Agent turn duration in seconds, by transport.",
    ["service", "transport"],
    buckets=(0.1, 0.5, 1, 2, 5, 10, 30, 60, 120),
)
_tasks_total = Counter(
    "ai37_agent_tasks_total",
    "Terminal task states produced by the host (completed|failed|input_required).",
    ["service", "final_state"],
)
_billing_denied_total = Counter(
    "ai37_billing_denied_total",
    "Billing preflight denials surfaced by the host, by reason.",
    ["service", "reason"],
)
_auth_failures_total = Counter(
    "ai37_agent_auth_failures_total",
    "401 responses from the host auth guard.",
    ["service"],
)


def norm_final_state(status: str) -> str:
    """AgentResult.status → label-safe (``input-required`` → ``input_required``)."""
    return "input_required" if status == "input-required" else status


def service_label(name: str | None) -> str:
    """``service``-лейбл из build_info['service']: строчный slug ``[a-z0-9_-]`` ≤63 симв.

    Значение ФИКСИРОВАНО на процесс (одно на деплой) → кардинальность лейбла = 1.
    """
    slug = re.sub(r"[^a-z0-9_-]+", "-", (name or "unknown").lower()).strip("-")[:63]
    return slug or "unknown"


def _safe(fn: Callable[[], None]) -> None:
    try:
        fn()
    except Exception:  # noqa: BLE001 - метрики не должны ломать ход агента
        pass


def observe_turn(service: str, transport: str, final_state: str, seconds: float) -> None:
    """Один ход (turn) на транспорте ``a2a``/``agui``: rate + errors + duration + terminal-state."""

    def _do() -> None:
        status = "error" if final_state == "failed" else "ok"
        _requests_total.labels(service, transport, status).inc()
        _request_duration.labels(service, transport).observe(seconds)
        _tasks_total.labels(service, final_state).inc()

    _safe(_do)


def record_billing_denied(service: str, reason: str) -> None:
    """Отказ биллинг-preflight (``BillingExecutionDeniedError.reason``)."""
    _safe(lambda: _billing_denied_total.labels(service, reason).inc())


def record_auth_failure(service: str) -> None:
    """401 из AuthGuardMiddleware (сбой Authentik/JWKS/верификатора)."""
    _safe(lambda: _auth_failures_total.labels(service).inc())
