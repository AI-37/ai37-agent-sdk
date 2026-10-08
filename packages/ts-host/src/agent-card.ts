import type { AgentCard } from '@a2a-js/sdk'

/**
 * Карточка агента в словаре хоста. По форме это поля A2A 0.3 (их сегодня пишет каждый агент) плюс
 * блок `x-ai37`. Тип свой, а не `AgentCard` из `@a2a-js/sdk`: в 1.x карточка перестроена
 * (`supportedInterfaces[]` вместо `url`/`preferredTransport`, protobuf-типы), и хост сам собирает из
 * этой формы карточку нужной версии. Агенту, который описывает карточку этим типом, смена SDK
 * ничего не ломает.
 *
 * Значение типа `AgentCard` из `@a2a-js/sdk` 0.3 сюда присваивается без приведения.
 */
export interface Ai37AgentCardInput {
  name: string
  description: string
  version: string
  /** Публичный URL основного A2A-эндпоинта (JSON-RPC). */
  url: string
  protocolVersion?: string
  preferredTransport?: string
  additionalInterfaces?: Ai37AgentCardInterface[]
  capabilities: Ai37AgentCapabilities
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: Ai37AgentSkill[]
  provider?: { organization: string; url: string }
  documentationUrl?: string
  iconUrl?: string
  securitySchemes?: { [name: string]: Ai37SecurityScheme }
  security?: { [name: string]: string[] }[]
  supportsAuthenticatedExtendedCard?: boolean
  signatures?: { protected: string; signature: string; header?: { [k: string]: unknown } }[]
  /** Блок экосистемы: биллинг, auth, skillsIo. Хост копирует его в публичную карточку как есть. */
  'x-ai37'?: object
}

/** Дополнительный интерфейс в форме 0.3 (`transport` = привязка: `JSONRPC`, `HTTP+JSON`, `GRPC`). */
export interface Ai37AgentCardInterface {
  url: string
  transport: string
}

export interface Ai37AgentCapabilities {
  streaming?: boolean
  pushNotifications?: boolean
  stateTransitionHistory?: boolean
  extensions?: Ai37AgentExtension[]
}

export interface Ai37AgentExtension {
  uri: string
  description?: string
  required?: boolean
  params?: { [k: string]: unknown }
}

/** Запись `skills[]` карточки. */
export interface Ai37AgentSkill {
  id: string
  name: string
  description: string
  tags: string[]
  examples?: string[]
  inputModes?: string[]
  outputModes?: string[]
  security?: { [name: string]: string[] }[]
}

/**
 * Схема безопасности в форме 0.3 (`type`: `http`, `apiKey`, `oauth2`, `openIdConnect`,
 * `mutualTLS`). Поля перечислены плоско, без union по `type`, чтобы сюда ложилась любая схема 0.3.
 */
export interface Ai37SecurityScheme {
  type: string
  description?: string
  scheme?: string
  bearerFormat?: string
  name?: string
  in?: string
  flows?: object
  oauth2MetadataUrl?: string
  openIdConnectUrl?: string
}

/** Интерфейс агента в форме A2A 1.0 (`AgentCard.supportedInterfaces[]`). */
export interface AgentInterface {
  url: string
  protocolBinding: string
  protocolVersion: string
  tenant?: string
}

/** Карточка, которую отдаёт хост: поля 0.3 + `supportedInterfaces` 1.0 + расширения `x-*`. */
export type PublicAgentCard = Ai37AgentCardInput & {
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
export function toPublicAgentCard(card: Ai37AgentCardInput): PublicAgentCard {
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

/**
 * Карточка для `DefaultRequestHandler` SDK. На 0.3 формы совпадают, `protocolVersion` по
 * умолчанию `'0.3'`. Наружу эта карточка не уходит: публичную отдаёт `toPublicAgentCard`.
 */
export function toSdkAgentCard(card: Ai37AgentCardInput): AgentCard {
  return { ...card, protocolVersion: card.protocolVersion ?? '0.3' } as AgentCard
}
