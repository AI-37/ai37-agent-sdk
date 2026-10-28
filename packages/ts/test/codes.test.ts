import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BillingFeatureCode, BillingPrivilegeCode } from '../src'

interface ContractCode {
  code: string
  constant: string
  name: string
}

// Тот же контракт читает Python-тест: перечисления обоих SDK обязаны совпадать с ним.
const contract = JSON.parse(
  readFileSync(new URL('../../../contract/feature-codes.json', import.meta.url), 'utf8'),
) as { features: ContractCode[]; privileges: ContractCode[] }

const asPairs = (items: ContractCode[]) =>
  Object.fromEntries(items.map((item) => [item.constant, item.code]))

describe('billing codes (contract/feature-codes.json)', () => {
  it('BillingFeatureCode mirrors the contract', () => {
    expect({ ...BillingFeatureCode }).toEqual(asPairs(contract.features))
  })

  it('BillingPrivilegeCode mirrors the contract', () => {
    expect({ ...BillingPrivilegeCode }).toEqual(asPairs(contract.privileges))
  })

  it.each([
    ['features', contract.features],
    ['privileges', contract.privileges],
  ])('%s have unique codes and constants', (_kind, items) => {
    expect(new Set(items.map((i) => i.code)).size).toBe(items.length)
    expect(new Set(items.map((i) => i.constant)).size).toBe(items.length)
  })

  it('exposes the Polimetrika data agent feature and its privilege', () => {
    expect(BillingFeatureCode.PolimetrikaDataAgent).toBe('polimetrika-data-agent')
    expect(BillingPrivilegeCode.PolimetrikaDataAgentAllowed).toBe('polimetrika-data-agent-allowed')
  })
})
