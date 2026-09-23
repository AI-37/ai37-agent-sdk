import { describe, expect, it } from 'vitest'
import { parsePolicyState, readPolicyState } from '../src/policy'

const ADMIN = {
  states: ['relaxed', 'attributed', 'closed'] as const,
  fallback: 'closed' as const,
}

describe('parsePolicyState', () => {
  it('принимает объявленное состояние', () => {
    for (const state of ADMIN.states) {
      expect(parsePolicyState(state, ADMIN)).toBe(state)
    }
  })

  it('сводит отсутствие, пустую строку и пробелы к дефолту вызывающего', () => {
    expect(parsePolicyState(undefined, ADMIN)).toBe('closed')
    expect(parsePolicyState('', ADMIN)).toBe('closed')
    expect(parsePolicyState('   ', ADMIN)).toBe('closed')
  })

  it('сводит нераспознанное к дефолту, а не к ближайшему похожему', () => {
    expect(parsePolicyState('relaxedd', ADMIN)).toBe('closed')
    expect(parsePolicyState('RELAXED', ADMIN)).toBe('closed')
    expect(parsePolicyState(42, ADMIN)).toBe('closed')
    expect(parsePolicyState(null, ADMIN)).toBe('closed')
  })

  it('обрезает пробелы вокруг годного значения', () => {
    expect(parsePolicyState(' relaxed ', ADMIN)).toBe('relaxed')
  })

  it('набор состояний принадлежит вызывающему', () => {
    const route = { states: ['relaxed', 'trusted', 'closed'] as const, fallback: 'closed' as const }
    expect(parsePolicyState('trusted', route)).toBe('trusted')
    expect(parsePolicyState('attributed', route)).toBe('closed')
  })

  it('дефолт-послабление тоже возможен — сторону выбирает вызывающий', () => {
    const relaxedByDefault = { states: ADMIN.states, fallback: 'relaxed' as const }
    expect(parsePolicyState('', relaxedByDefault)).toBe('relaxed')
  })
})

describe('readPolicyState', () => {
  it('читает произвольно названную переменную', () => {
    expect(readPolicyState('ADMIN_CONTENT_READ', ADMIN, { ADMIN_CONTENT_READ: 'attributed' })).toBe(
      'attributed',
    )
  })

  it('незаданная переменная даёт дефолт', () => {
    expect(readPolicyState('ADMIN_CONTENT_READ', ADMIN, {})).toBe('closed')
  })
})
