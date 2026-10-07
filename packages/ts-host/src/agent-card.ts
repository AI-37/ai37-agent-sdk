import type { AgentCard } from '@a2a-js/sdk'

/** Интерфейс агента в форме A2A 1.0 (`AgentCard.supportedInterfaces[]`). */
export interface AgentInterface {
  url: string
  protocolBinding: string
  protocolVersion: string
  tenant?: string
}

/** Карточка, которую отдаёт хост: поля 0.3 + `supportedInterfaces` 1.0 + расширения `x-*`. */
export type PublicAgentCard = AgentCard & {
  supportedInterfaces?: AgentInterface[]
  [extension: `x-${string}`]: unknown
}

/**
 * Гибридная карточка (как в python-host): поля 0.3 остаются для текущих клиентов, рядом
 * `supportedInterfaces` в форме 1.0. Парсер 0.3 лишние поля игнорирует, клиент `@a2a-js/sdk`
 * 1.x по `supportedInterfaces` с `protocolVersion: '0.3'` выбирает legacy-транспорт.
 *
 * Расширения (`x-ai37`: биллинг, skillsIo) копируются как есть. Поэтому карточку хост отдаёт
 * своим роутом, а не `agentCardHandler` SDK: в 1.x его compat-режим собирает 0.3-карточку
 * поштучно и `x-ai37` теряет, а оркестратор берёт из него биллинг-гейты.
 *
 * Если агент уже задал `supportedInterfaces` сам, они не трогаются.
 */
export function toPublicAgentCard(card: AgentCard): PublicAgentCard {
  const own = card as PublicAgentCard
  if (own.supportedInterfaces?.length) return own
  const version = card.protocolVersion ?? '0.3'
  const interfaces: AgentInterface[] = []
  const seen = new Set<string>()
  const add = (url: string | undefined, binding: string | undefined) => {
    if (!url) return
    const protocolBinding = binding || 'JSONRPC'
    const key = `${protocolBinding} ${url}`
    if (seen.has(key)) return
    seen.add(key)
    interfaces.push({ url, protocolBinding, protocolVersion: version })
  }
  add(card.url, card.preferredTransport)
  for (const extra of card.additionalInterfaces ?? []) add(extra.url, extra.transport)
  return interfaces.length ? { ...own, supportedInterfaces: interfaces } : own
}
