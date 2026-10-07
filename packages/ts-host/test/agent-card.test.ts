import { describe, expect, it } from 'vitest'
import type { AgentCard } from '@a2a-js/sdk'
import { toPublicAgentCard } from '../src/agent-card'

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

describe('toPublicAgentCard', () => {
  it('основной url + additionalInterfaces, без дублей, версия из карточки', () => {
    const card = toPublicAgentCard({
      ...base,
      preferredTransport: 'JSONRPC',
      additionalInterfaces: [
        { url: 'https://agent/a2a/v1', transport: 'JSONRPC' },
        { url: 'https://agent/a2a/rest', transport: 'HTTP+JSON' },
      ],
    })
    expect(card.supportedInterfaces).toEqual([
      { url: 'https://agent/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '0.3.0' },
      { url: 'https://agent/a2a/rest', protocolBinding: 'HTTP+JSON', protocolVersion: '0.3.0' },
    ])
    expect(card.url).toBe('https://agent/a2a/v1')
  })

  it('без preferredTransport — JSONRPC, без protocolVersion — 0.3', () => {
    const { protocolVersion: _omit, ...noVersion } = base
    const card = toPublicAgentCard(noVersion as AgentCard)
    expect(card.supportedInterfaces).toEqual([
      { url: 'https://agent/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ])
  })

  it('свои supportedInterfaces агента не трогает', () => {
    const own = [{ url: 'https://agent/v2', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]
    const card = toPublicAgentCard({ ...base, supportedInterfaces: own } as AgentCard)
    expect(card.supportedInterfaces).toBe(own)
  })

  it('без url интерфейсы не выдумывает', () => {
    const card = toPublicAgentCard({ ...base, url: '' })
    expect(card.supportedInterfaces).toBeUndefined()
  })

  it('исходную карточку не мутирует', () => {
    const src = { ...base }
    toPublicAgentCard(src)
    expect('supportedInterfaces' in src).toBe(false)
  })
})
