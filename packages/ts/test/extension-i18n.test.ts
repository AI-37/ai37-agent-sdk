import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AI37_ROUTING_EXTENSION_URI,
  AI37_SHOWCASE_EXTENSION_URI,
  buildAgentShowcaseExtension,
  localizeAgentRoutingProfile,
  localizeAgentShowcaseProfile,
  normalizeAgentRoutingProfile,
  normalizeAgentShowcaseProfile,
  parseAgentRoutingExtension,
  parseAgentShowcaseExtension,
} from '../src'

interface NormalizeCase {
  name: string
  input: unknown
  expected: unknown
}

interface LocalizeCases {
  profile: unknown
  cases: { name: string; locale: string | null; expected: unknown }[]
}

// Те же векторы читает Python-тест: переводы карточки оба SDK выбирают одинаково.
const VECTORS = JSON.parse(
  readFileSync(new URL('../../../contract/a2a-extension-i18n.vectors.json', import.meta.url), 'utf8'),
) as {
  showcaseNormalize: NormalizeCase[]
  showcaseLocalize: LocalizeCases
  routingNormalize: NormalizeCase[]
  routingLocalize: LocalizeCases
}

describe('showcase/v1: i18n', () => {
  it.each(VECTORS.showcaseNormalize)('normalize: $name', ({ input, expected }) => {
    expect(normalizeAgentShowcaseProfile(input)).toEqual(expected)
  })

  const showcase = normalizeAgentShowcaseProfile(VECTORS.showcaseLocalize.profile)
  it.each(VECTORS.showcaseLocalize.cases)('localize: $name', ({ locale, expected }) => {
    expect(localizeAgentShowcaseProfile(showcase, locale ?? undefined)).toEqual(expected)
  })

  it('переводы переживают build и parse карточки', () => {
    const extension = buildAgentShowcaseExtension(showcase)
    const parsed = parseAgentShowcaseExtension([extension])
    expect(parsed?.i18n?.['es-MX']).toEqual({ title: 'Cálculo de elevadores' })
    expect(parsed).toEqual(showcase)
  })

  it('профиль без i18n локализуется в себя же', () => {
    const plain = normalizeAgentShowcaseProfile({ title: 'Поиск', summary: 'Поиск по документам' })
    expect(localizeAgentShowcaseProfile(plain, 'es')).toEqual(plain)
  })

  it('локализация не меняет исходный профиль', () => {
    const before = structuredClone(showcase)
    localizeAgentShowcaseProfile(showcase, 'en')
    expect(showcase).toEqual(before)
  })

  it('старый потребитель видит русскую базу: базовые поля не тронуты', () => {
    expect(showcase.title).toBe('Расчёт лифтов')
    expect(showcase.capabilities?.[0]?.title).toBe('Жилые здания')
    expect(AI37_SHOWCASE_EXTENSION_URI).toMatch(/\/showcase\/v1$/)
  })
})

describe('routing/v1: i18n', () => {
  it.each(VECTORS.routingNormalize)('normalize: $name', ({ input, expected }) => {
    expect(normalizeAgentRoutingProfile(input)).toEqual(expected)
  })

  const routing = normalizeAgentRoutingProfile(VECTORS.routingLocalize.profile)
  it.each(VECTORS.routingLocalize.cases)('localize: $name', ({ locale, expected }) => {
    expect(localizeAgentRoutingProfile(routing, locale ?? undefined)).toEqual(expected)
  })

  it('кривой перевод не роняет разбор карточки', () => {
    const profile = parseAgentRoutingExtension([
      {
        uri: AI37_ROUTING_EXTENSION_URI,
        params: {
          domains: ['лифты'],
          intents: ['engineering_calculation'],
          excludes: [],
          i18n: { es: { excludes: [1, 2] }, en: 'broken' },
        },
      },
    ])
    expect(profile).toEqual({ domains: ['лифты'], intents: ['engineering_calculation'], excludes: [] })
  })

  it('база по-прежнему строгая: битые базовые excludes отвергают профиль', () => {
    expect(() =>
      normalizeAgentRoutingProfile({
        domains: [],
        intents: [],
        excludes: 'not a list',
        i18n: { es: { excludes: ['ok'] } },
      }),
    ).toThrow(TypeError)
  })
})
