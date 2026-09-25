import { describe, expect, it } from 'vitest'
import {
  AI37_SHOWCASE_EXTENSION_URI,
  buildAgentShowcaseExtension,
  normalizeAgentShowcaseProfile,
  parseAgentShowcaseExtension,
} from '../src'

describe('AI37 A2A showcase extension', () => {
  it('builds and parses a full showcase profile', () => {
    const extension = buildAgentShowcaseExtension({
      title: ' Расчёт лифтов ',
      summary: 'Подбор числа и параметров лифтов по этажности и заселённости',
      computes: 'Число лифтов, интервал движения, провозная способность группы',
      norms: [
        {
          code: 'ГОСТ 34758-2021',
          title: 'Лифты. Определение числа, параметров и размеров лифтов',
        },
        { code: 'гост 34758-2021' },
      ],
      starter: 'Запусти расчёт лифтов',
      examples: ['Подбери лифты для жилого дома 17 этажей', ' '],
      order: 3,
    })

    expect(extension.uri).toBe(AI37_SHOWCASE_EXTENSION_URI)
    expect(extension.required).toBe(false)
    expect(extension.params.title).toBe('Расчёт лифтов')
    // Дубль норматива в другом регистре и пустой пример отбрасываются.
    expect(extension.params.norms).toHaveLength(1)
    expect(extension.params.examples).toEqual(['Подбери лифты для жилого дома 17 этажей'])
    expect(parseAgentShowcaseExtension([extension])).toEqual(extension.params)
  })

  it('omits optional fields instead of emitting them empty', () => {
    const profile = normalizeAgentShowcaseProfile({
      title: 'Проверка подрядчика',
      summary: 'Проверка контрагента по реестрам Минстроя',
      norms: [],
      examples: [],
      computes: '   ',
    })

    expect(profile).toEqual({
      title: 'Проверка подрядчика',
      summary: 'Проверка контрагента по реестрам Минстроя',
    })
  })

  it('clamps over-long text and marks it as truncated', () => {
    const profile = normalizeAgentShowcaseProfile({
      title: 'а'.repeat(70),
      summary: 'б'.repeat(200),
      computes: 'в'.repeat(300),
    })

    expect(profile.title).toHaveLength(60)
    expect(profile.title.endsWith('…')).toBe(true)
    expect(profile.summary).toHaveLength(160)
    expect(profile.computes).toHaveLength(240)
  })

  it('counts and cuts by code points, so a surrogate pair never breaks in half', () => {
    // 60 кодовых точек, из них одна — эмодзи. По контракту заголовок валиден и обрезаться не должен;
    // подсчёт по UTF-16 дал бы 61 и разрезал бы пару, оставив висячий суррогат в карточке.
    const title = `${'а'.repeat(58)}😀б`
    expect([...title]).toHaveLength(60)

    const profile = normalizeAgentShowcaseProfile({ title, summary: 'с' })

    expect(profile.title).toBe(title)
    expect([...profile.title].some((ch) => /[\uD800-\uDFFF]/u.test(ch))).toBe(false)
  })

  it('clamps an over-long emoji title without emitting a lone surrogate', () => {
    const profile = normalizeAgentShowcaseProfile({ title: '😀'.repeat(70), summary: 'с' })

    expect([...profile.title]).toHaveLength(60)
    expect(profile.title.endsWith('…')).toBe(true)
    // Каждая точка — целое эмодзи: обрезка прошла по границам, а не по code units.
    expect([...profile.title].slice(0, -1).every((ch) => ch === '😀')).toBe(true)
  })

  it('drops items beyond the limits and malformed ones', () => {
    const profile = normalizeAgentShowcaseProfile({
      title: 'Расчёт КЕО',
      summary: 'Коэффициент естественной освещённости помещений',
      norms: [
        { code: 'СП 52.13330' },
        'СП 367.1325800.2017',
        { title: 'без кода' },
        { code: 'ГОСТ Р 21.514—2025' },
        { code: 'СП 23-102-2003' },
        { code: 'СанПиН 1.2.3685-21' },
        { code: 'пятый лишний' },
      ],
      examples: ['первый', 'второй', 'третий', 'четвёртый', 'пятый'],
    })

    expect(profile.norms?.map((norm) => norm.code)).toEqual([
      'СП 52.13330',
      'ГОСТ Р 21.514—2025',
      'СП 23-102-2003',
      'СанПиН 1.2.3685-21',
    ])
    expect(profile.examples).toEqual(['первый', 'второй', 'третий', 'четвёртый'])
  })

  it('keeps an integer order and drops anything else', () => {
    expect(normalizeAgentShowcaseProfile({ title: 'т', summary: 'с', order: 2 }).order).toBe(2)
    for (const order of [1.5, Number.NaN, '3', true, null]) {
      expect(
        normalizeAgentShowcaseProfile({ title: 'т', summary: 'с', order }).order,
      ).toBeUndefined()
    }
  })

  it('requires a title and a summary', () => {
    expect(() => normalizeAgentShowcaseProfile({ summary: 'есть' })).toThrow(
      /title and showcase.summary are required/,
    )
    expect(() => normalizeAgentShowcaseProfile({ title: 'есть', summary: '  ' })).toThrow(
      /title and showcase.summary are required/,
    )
    expect(() => normalizeAgentShowcaseProfile(['не объект'])).toThrow(
      /showcase profile must be an object/,
    )
  })

  it('ignores a card without the extension or with a broken profile', () => {
    expect(parseAgentShowcaseExtension(undefined)).toBeUndefined()
    expect(parseAgentShowcaseExtension([{ uri: 'urn:other', params: {} }])).toBeUndefined()
    expect(
      parseAgentShowcaseExtension([
        { uri: AI37_SHOWCASE_EXTENSION_URI, params: { summary: 'без заголовка' } },
      ]),
    ).toBeUndefined()
  })

  it('strips control characters and angle brackets from card text', () => {
    const profile = normalizeAgentShowcaseProfile({
      title: `Расчёт${String.fromCharCode(7)} ОВиК`,
      summary: '<script>alert(1)</script> расчёт',
    })

    expect(profile.title).toBe('Расчёт ОВиК')
    expect(profile.summary).toBe('script alert(1) /script расчёт')
  })
})
