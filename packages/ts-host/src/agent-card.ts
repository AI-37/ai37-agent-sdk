import {
  SecurityScheme,
  type AgentCard,
  type AgentInterface as SdkAgentInterface,
  type SecurityRequirement,
} from '@a2a-js/sdk'
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3'

/**
 * Карточка агента в словаре хоста. По форме это поля A2A 0.3 (их сегодня пишет каждый агент) плюс
 * блок `x-ai37`. Тип свой, а не `AgentCard` из `@a2a-js/sdk`: в 1.x карточка перестроена
 * (`supportedInterfaces[]` вместо `url`/`preferredTransport`, protobuf-типы), и хост сам собирает из
 * этой формы карточку нужной версии. Агенту, который описывает карточку этим типом, смена SDK
 * ничего не ломает.
 *
 * Карточка `AgentCard` из `@a2a-js/sdk` 0.3 (её форма) сюда присваивается без приведения.
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

const JSONRPC = 'JSONRPC'
const V1 = '1.0'

/**
 * `supportedInterfaces` хоста. JSON-RPC-эндпоинт объявлен дважды, версиями `1.0` и `0.3`: сервер
 * 1.x принимает 0.3 на привязке, только если она объявлена с `protocolVersion: '0.3'`
 * (`validateVersion` и `legacyCompat`), а клиент 1.x выбирает интерфейс `1.0`, когда он есть.
 * Прочие привязки из `additionalInterfaces` (хост их не обслуживает) остаются с версией карточки.
 *
 * Свои `supportedInterfaces` агента (если он их задал) берутся как есть, к JSON-RPC добавляется
 * 0.3-дубль, если его нет. `legacyCompat: false` — хост 0.3 не принимает, и 0.3-дубля нет.
 */
export function hostInterfaces(card: Ai37AgentCardInput, legacyCompat = true): AgentInterface[] {
  const finish = (list: AgentInterface[]) => (legacyCompat ? withLegacyJsonRpc(list) : list)
  const own = (card as PublicAgentCard).supportedInterfaces
  if (own?.length) return finish(own)
  const legacyVersion = card.protocolVersion || '0.3'
  const interfaces: AgentInterface[] = []
  const seen = new Set<string>()
  const add = (url: string | undefined, binding: string | undefined) => {
    if (!url) return
    const protocolBinding = binding || JSONRPC
    const key = `${protocolBinding} ${url}`
    if (seen.has(key)) return
    seen.add(key)
    if (protocolBinding === JSONRPC) {
      interfaces.push({ url, protocolBinding, protocolVersion: V1 })
    } else {
      interfaces.push({ url, protocolBinding, protocolVersion: legacyVersion })
    }
  }
  add(card.url, card.preferredTransport)
  for (const extra of card.additionalInterfaces ?? []) add(extra.url, extra.transport)
  return finish(interfaces)
}

function withLegacyJsonRpc(interfaces: AgentInterface[]): AgentInterface[] {
  const full = interfaces.map((i) => ({ ...i, tenant: i.tenant ?? '' }))
  return duplicateInterfacesForLegacy(full, [JSONRPC]).map(({ tenant, ...rest }) =>
    tenant ? { ...rest, tenant } : rest,
  )
}

/**
 * Гибридная карточка (как в python-host): поля 0.3 остаются для клиентов 0.3, рядом
 * `supportedInterfaces` в форме 1.0, где JSON-RPC объявлен версиями `1.0` и `0.3`. Парсер 0.3 лишние
 * поля игнорирует; клиент `@a2a-js/sdk` 1.x видит непустой `supportedInterfaces`, считает карточку
 * карточкой 1.0 и идёт в интерфейс `1.0`.
 *
 * Расширения (`x-ai37`: биллинг, skillsIo) копируются как есть. Поэтому карточку хост отдаёт своим
 * роутом, а не `agentCardHandler` SDK: в compat-режиме тот собирает 0.3-карточку поштучно и `x-ai37`
 * теряет, а оркестратор берёт из него биллинг-гейты.
 */
export function toPublicAgentCard(
  card: Ai37AgentCardInput,
  opts: { legacyCompat?: boolean } = {},
): PublicAgentCard {
  const interfaces = hostInterfaces(card, opts.legacyCompat ?? true)
  return interfaces.length ? { ...card, supportedInterfaces: interfaces } : { ...card }
}

/**
 * Карточка 1.x для `DefaultRequestHandler`. Наружу она не уходит (публичную отдаёт
 * `toPublicAgentCard`), обработчику из неё нужны `supportedInterfaces` (проверка версии запроса),
 * `capabilities` (стриминг, обязательные расширения) и режимы ввода. Схемы безопасности
 * переводятся в protobuf-форму, неизвестный тип схемы пропускается.
 */
export function toSdkAgentCard(card: Ai37AgentCardInput, opts: { legacyCompat?: boolean } = {}): AgentCard {
  return {
    name: card.name,
    description: card.description,
    version: card.version,
    supportedInterfaces: hostInterfaces(card, opts.legacyCompat ?? true).map(
      (i): SdkAgentInterface => ({ ...i, tenant: i.tenant ?? '' }),
    ),
    provider: card.provider ? { url: card.provider.url, organization: card.provider.organization } : undefined,
    ...(card.documentationUrl !== undefined ? { documentationUrl: card.documentationUrl } : {}),
    ...(card.iconUrl !== undefined ? { iconUrl: card.iconUrl } : {}),
    capabilities: {
      ...(card.capabilities.streaming !== undefined ? { streaming: card.capabilities.streaming } : {}),
      ...(card.capabilities.pushNotifications !== undefined
        ? { pushNotifications: card.capabilities.pushNotifications }
        : {}),
      ...(card.supportsAuthenticatedExtendedCard !== undefined
        ? { extendedAgentCard: card.supportsAuthenticatedExtendedCard }
        : {}),
      extensions: (card.capabilities.extensions ?? []).map((e) => ({
        uri: e.uri,
        description: e.description ?? '',
        required: e.required ?? false,
        params: e.params,
      })),
    },
    securitySchemes: toSdkSecuritySchemes(card.securitySchemes),
    securityRequirements: toSdkSecurityRequirements(card.security),
    defaultInputModes: card.defaultInputModes,
    defaultOutputModes: card.defaultOutputModes,
    skills: card.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags,
      examples: s.examples ?? [],
      inputModes: s.inputModes ?? [],
      outputModes: s.outputModes ?? [],
      securityRequirements: toSdkSecurityRequirements(s.security),
    })),
    signatures: [],
  }
}

function toSdkSecurityRequirements(
  security: Ai37AgentCardInput['security'],
): SecurityRequirement[] {
  return (security ?? []).map((req) => ({
    schemes: Object.fromEntries(Object.entries(req).map(([name, scopes]) => [name, { list: scopes }])),
  }))
}

/** 0.3 → protobuf-JSON 1.x (`{ httpAuthSecurityScheme: {...} }`), разбор — `SecurityScheme.fromJSON`. */
const SCHEME_CASE: Record<string, string> = {
  http: 'httpAuthSecurityScheme',
  apiKey: 'apiKeySecurityScheme',
  oauth2: 'oauth2SecurityScheme',
  openIdConnect: 'openIdConnectSecurityScheme',
  mutualTLS: 'mtlsSecurityScheme',
}

function toSdkSecuritySchemes(
  schemes: Ai37AgentCardInput['securitySchemes'],
): AgentCard['securitySchemes'] {
  const out: AgentCard['securitySchemes'] = {}
  for (const [name, scheme] of Object.entries(schemes ?? {})) {
    const key = SCHEME_CASE[scheme.type]
    if (!key) continue
    const { type: _type, in: location, ...rest } = scheme
    out[name] = SecurityScheme.fromJSON({
      [key]: { ...rest, ...(location !== undefined ? { location } : {}) },
    })
  }
  return out
}
