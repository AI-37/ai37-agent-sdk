import { describe, expect, it } from 'vitest'
import { AgentCard as SdkAgentCard } from '@a2a-js/sdk'
import type { Ai37AgentCardInput as AgentCard } from '../src/index'
import { toPublicAgentCard, toSdkAgentCard } from '../src/agent-card'

const base: AgentCard = {
  name: 'a',
  description: 'd',
  version: '1',
  url: 'https://agent/a2a/v1',
  protocolVersion: '0.3.0',
  capabilities: {},
  defaultInputModes: [],
  defaultOutputModes: [],
  skills: [],
}

/** Карточка в той форме, в какой её сегодня пишут агенты (daylight/elevator). */
const realistic: AgentCard = {
  ...base,
  protocolVersion: '0.3',
  preferredTransport: 'JSONRPC',
  additionalInterfaces: [{ url: 'https://agent/a2a/v1', transport: 'JSONRPC' }],
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extensions: [{ uri: 'urn:catalog', description: 'A2UI catalog', required: false }],
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['text/markdown', 'text/plain'],
  securitySchemes: {
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'User-JWT' },
    apiKeyAuth: { type: 'http', scheme: 'bearer', description: 'AI37 API-ключ' },
    header: { type: 'apiKey', in: 'header', name: 'X-Key' },
  },
  security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
  skills: [{ id: 'calc', name: 'Расчёт', description: 'd', tags: ['x'], examples: ['пример'] }],
  'x-ai37': { billing: { feature: 'calc' } },
}

describe('toPublicAgentCard', () => {
  it('JSON-RPC объявлен версиями 1.0 и 0.3; прочие привязки — с версией карточки', () => {
    const card = toPublicAgentCard({
      ...base,
      preferredTransport: 'JSONRPC',
      additionalInterfaces: [
        { url: 'https://agent/a2a/v1', transport: 'JSONRPC' },
        { url: 'https://agent/a2a/rest', transport: 'HTTP+JSON' },
      ],
    })
    expect(card.supportedInterfaces).toEqual([
      { url: 'https://agent/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: 'https://agent/a2a/rest', protocolBinding: 'HTTP+JSON', protocolVersion: '0.3.0' },
      { url: 'https://agent/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ])
    // Поля 0.3 верхнего уровня на месте: их читают клиенты 0.3.
    expect(card.url).toBe('https://agent/a2a/v1')
    expect(card.protocolVersion).toBe('0.3.0')
  })

  it('без preferredTransport — JSONRPC', () => {
    const { protocolVersion: _omit, ...noVersion } = base
    const card = toPublicAgentCard(noVersion as AgentCard)
    expect(card.supportedInterfaces).toEqual([
      { url: 'https://agent/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: 'https://agent/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ])
  })

  it('свои supportedInterfaces агента берутся как есть, к JSON-RPC добавляется 0.3-дубль', () => {
    const own = [{ url: 'https://agent/v2', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]
    const card = toPublicAgentCard({ ...base, supportedInterfaces: own } as AgentCard)
    expect(card.supportedInterfaces).toEqual([
      { url: 'https://agent/v2', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: 'https://agent/v2', protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ])
  })

  it('без url интерфейсы не выдумывает', () => {
    const card = toPublicAgentCard({ ...base, url: '' })
    expect(card.supportedInterfaces).toBeUndefined()
  })

  it('исходную карточку не мутирует, x-ai37 копирует как есть', () => {
    const src = { ...realistic }
    const card = toPublicAgentCard(src)
    expect('supportedInterfaces' in src).toBe(false)
    expect(card['x-ai37']).toEqual({ billing: { feature: 'calc' } })
    expect(card.securitySchemes).toEqual(realistic.securitySchemes)
  })
})

describe('toSdkAgentCard (карточка для DefaultRequestHandler 1.x)', () => {
  it('интерфейсы 1.0 + 0.3, capabilities и навыки с дефолтами protobuf', () => {
    const card = toSdkAgentCard(realistic)
    expect(card.supportedInterfaces).toEqual([
      { url: 'https://agent/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' },
      { url: 'https://agent/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '0.3', tenant: '' },
    ])
    expect(card.capabilities).toEqual({
      streaming: true,
      pushNotifications: false,
      extensions: [{ uri: 'urn:catalog', description: 'A2UI catalog', required: false, params: undefined }],
    })
    expect(card.skills[0]).toMatchObject({ id: 'calc', examples: ['пример'], inputModes: [], securityRequirements: [] })
  })

  it('схемы безопасности 0.3 → oneof 1.x, security → securityRequirements', () => {
    const card = toSdkAgentCard(realistic)
    expect(card.securitySchemes.bearerAuth.scheme).toEqual({
      $case: 'httpAuthSecurityScheme',
      value: { description: 'User-JWT', scheme: 'bearer', bearerFormat: 'JWT' },
    })
    expect(card.securitySchemes.header.scheme).toEqual({
      $case: 'apiKeySecurityScheme',
      value: { description: '', location: 'header', name: 'X-Key' },
    })
    expect(card.securityRequirements).toEqual([
      { schemes: { bearerAuth: { list: [] } } },
      { schemes: { apiKeyAuth: { list: [] } } },
    ])
  })

  it('сериализуется protobuf-JSON SDK без потерь и без x-ai37', () => {
    const json = SdkAgentCard.toJSON(toSdkAgentCard(realistic)) as Record<string, unknown>
    expect(json['x-ai37']).toBeUndefined()
    expect(SdkAgentCard.fromJSON(json as never).securitySchemes.bearerAuth.scheme?.$case).toBe(
      'httpAuthSecurityScheme',
    )
  })

  it('неизвестный тип схемы пропускается, а не роняет старт', () => {
    const card = toSdkAgentCard({ ...base, securitySchemes: { weird: { type: 'magic' } } })
    expect(card.securitySchemes).toEqual({})
  })
})
