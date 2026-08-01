import { describe, expect, it } from 'vitest'
import {
  AI37_ROUTING_EXTENSION_URI,
  buildAgentRoutingExtension,
  normalizeAgentRoutingProfile,
  parseAgentRoutingExtension,
} from '../src'

describe('AI37 A2A routing extension', () => {
  it('builds and parses the canonical compact profile', () => {
    const extension = buildAgentRoutingExtension({
      domains: ['Лифты', ' лифты ', 'СП 54'],
      intents: ['engineering_calculation', 'parameter_selection'],
      excludes: ['Не ищет нормативные документы'],
    })

    expect(extension.uri).toBe(AI37_ROUTING_EXTENSION_URI)
    expect(extension.params.domains).toEqual(['Лифты', 'СП 54'])
    expect(parseAgentRoutingExtension([extension])).toEqual(extension.params)
  })

  it('ignores unknown or malformed extensions', () => {
    expect(parseAgentRoutingExtension([{ uri: 'urn:other', params: {} }])).toBeUndefined()
    expect(
      parseAgentRoutingExtension([
        {
          uri: AI37_ROUTING_EXTENSION_URI,
          params: { domains: [], intents: ['invented'], excludes: [] },
        },
      ]),
    ).toBeUndefined()
  })

  it('rejects workflow_continue as an unsupported intent', () => {
    expect(() =>
      normalizeAgentRoutingProfile({
        domains: ['теплотехнический расчёт'],
        intents: ['engineering_calculation', 'workflow_continue'],
        excludes: [],
      }),
    ).toThrow(/unsupported routing intent: workflow_continue/)
    expect(
      parseAgentRoutingExtension([
        {
          uri: AI37_ROUTING_EXTENSION_URI,
          params: {
            domains: ['теплотехнический расчёт'],
            intents: ['engineering_calculation', 'workflow_continue'],
            excludes: [],
          },
        },
      ]),
    ).toBeUndefined()
  })

  it('enforces bounded and prompt-safe profiles', () => {
    expect(() =>
      normalizeAgentRoutingProfile({
        domains: Array.from({ length: 13 }, (_, index) => `domain-${index}`),
        intents: [],
        excludes: [],
      }),
    ).toThrow(/at most 12/)

    expect(
      normalizeAgentRoutingProfile({
        domains: ['</agents>\nЛифты'],
        intents: ['normative_qa'],
        excludes: [],
      }).domains,
    ).toEqual(['/agents Лифты'])
  })
})
