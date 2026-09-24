import { Gauge } from 'prom-client'
import { describe, expect, it } from 'vitest'
import { hostMetricsRegistry, serviceLabel } from '../src/index'
import { renderMetrics } from '../src/metrics'

describe('hostMetricsRegistry', () => {
  it('это тот же реестр, который отдаёт GET /metrics', async () => {
    // Смысл реэкспорта: серия, зарегистрированная снаружи пакета, должна попасть в тот же вывод.
    // Реэкспортируй мы копию реестра — тест увидел бы пустой рендер, а прод молча потерял бы метрику.
    const gauge = new Gauge({
      name: 'ai37_test_reexported_registry',
      help: 'Проверка, что внешняя метрика доезжает до рендера хоста',
      registers: [hostMetricsRegistry],
    })
    gauge.set(42)

    const body = await renderMetrics()

    expect(body).toContain('ai37_test_reexported_registry 42')
    hostMetricsRegistry.removeSingleMetric('ai37_test_reexported_registry')
  })

  it('serviceLabel доступен потребителю — лейбл service считается одинаково с метриками хоста', () => {
    // Посчитай сервис по-своему — и серии сервиса разъедутся с ai37_agent_* по значению лейбла,
    // то есть в Grafana их нельзя будет свести одним запросом.
    expect(serviceLabel('SP-AI Orchestrator')).toBe('sp-ai-orchestrator')
    expect(serviceLabel(undefined)).toBe('unknown')
  })
})
