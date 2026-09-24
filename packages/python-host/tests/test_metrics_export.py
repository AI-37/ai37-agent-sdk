from prometheus_client import Gauge, generate_latest

from ai37_agent_host import host_metrics_registry, service_label


def test_external_metric_reaches_host_registry() -> None:
    """Серия, созданная снаружи пакета, должна попадать в тот вывод, который отдаёт /metrics.

    Экспортируй мы не тот реестр — тест увидел бы пустой рендер, а прод молча потерял бы метрику.
    """
    gauge = Gauge(
        "ai37_test_reexported_registry",
        "Проверка, что внешняя метрика доезжает до рендера хоста",
        registry=host_metrics_registry,
    )
    try:
        gauge.set(42)
        body = generate_latest(host_metrics_registry).decode()
        assert "ai37_test_reexported_registry 42.0" in body
    finally:
        host_metrics_registry.unregister(gauge)


def test_service_label_matches_host_metrics() -> None:
    """Посчитай сервис по-своему — и серии сервиса разъедутся с ai37_agent_* по значению лейбла."""
    assert service_label("SP-AI Orchestrator") == "sp-ai-orchestrator"
    assert service_label(None) == "unknown"
