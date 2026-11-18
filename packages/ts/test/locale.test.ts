import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BILLING_USER_MESSAGES,
  BILLING_USER_MESSAGES_BY_LOCALE,
  BillingExecutionDeniedError,
  DEFAULT_BILLING_USER_MESSAGE,
  DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE,
  FALLBACK_LOCALE,
  LEGACY_DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  billingUserMessage,
  canonicalLocaleTag,
  friendlyBillingMessage,
  localeChain,
  localeNativeName,
  normalizeLocale,
  resolveRequestLocale,
  t,
  userLocaleInstruction,
} from '../src'
import type { BillingRuntimeState } from '../src'

const TAGS = SUPPORTED_LOCALES.map((l) => l.tag)

describe('SUPPORTED_LOCALES', () => {
  it('шесть языков первой волны, у каждого есть название на нём самом', () => {
    expect(TAGS).toEqual(['ru', 'en', 'es', 'de', 'fr', 'pt'])
    for (const l of SUPPORTED_LOCALES) expect(l.nativeName.length).toBeGreaterThan(0)
  })

  it('список заморожен: потребитель не может его подменить', () => {
    expect(Object.isFrozen(SUPPORTED_LOCALES)).toBe(true)
  })
})

interface LocaleVectors {
  supportedLocales: string[]
  canonicalLocaleTag: [unknown, string | null][]
  localeChain: [string | null, string[]][]
  normalizeLocale: [string | null, string][]
  resolveRequestLocale: { metadata: unknown; claims: Record<string, unknown> | null; expected: string }[]
  userLocaleInstruction: Record<string, string>
  billingUserMessage: [string, string | null, string][]
}

/** Общие векторы с Python (`contract/locale.vectors.json`): обе реализации дают один результат. */
const VECTORS = JSON.parse(
  readFileSync(new URL('../../../contract/locale.vectors.json', import.meta.url), 'utf8'),
) as LocaleVectors

describe('общие векторы contract/locale.vectors.json', () => {
  it('SUPPORTED_LOCALES совпадает со списком контракта', () => {
    expect(TAGS).toEqual(VECTORS.supportedLocales)
  })

  it.each(VECTORS.canonicalLocaleTag)('canonicalLocaleTag(%j) → %j (тег не обрезается)', (raw, expected) => {
    expect(canonicalLocaleTag(raw) ?? null).toBe(expected)
  })

  it.each(VECTORS.localeChain)('localeChain(%j) → %j', (raw, expected) => {
    expect(localeChain(raw ?? undefined)).toEqual(expected)
  })

  it.each(VECTORS.normalizeLocale)('normalizeLocale(%j) → %j (В8)', (raw, expected) => {
    expect(normalizeLocale(raw ?? undefined)).toBe(expected)
  })

  it.each(VECTORS.resolveRequestLocale)('resolveRequestLocale %j', ({ metadata, claims, expected }) => {
    expect(resolveRequestLocale(metadata, claims)).toBe(expected)
  })

  it.each(Object.entries(VECTORS.userLocaleInstruction))('userLocaleInstruction(%s) — точный текст', (locale, text) => {
    expect(userLocaleInstruction(locale)).toBe(text)
  })

  it.each(VECTORS.billingUserMessage)('billingUserMessage(%s, %j)', (reason, locale, text) => {
    expect(billingUserMessage(reason, locale ?? undefined)).toBe(text)
  })
})

describe('resolveRequestLocale: смысл порядка', () => {
  it('локаль конверта важнее claims; без всего — ru (обратная совместимость)', () => {
    expect(resolveRequestLocale('es', { locale: 'de', org_locale: 'fr' })).toBe('es')
    expect(resolveRequestLocale(undefined, undefined)).toBe(LEGACY_DEFAULT_LOCALE)
  })

  it('язык вне списка не отвергается, тег с регионом не обрезается (§10)', () => {
    expect(resolveRequestLocale('pl', undefined)).toBe('pl')
    expect(resolveRequestLocale('es-mx', undefined)).toBe('es-MX')
  })

  it('чужой и пустой язык нормализуются в en', () => {
    expect(normalizeLocale('uk')).toBe(FALLBACK_LOCALE)
  })
})

describe('t: строка по цепочке фолбэков', () => {
  const dict = { ru: 'Готово', en: 'Done', es: 'Hecho', 'es-MX': 'Listo' }

  it('точный тег, затем язык без региона', () => {
    expect(t('es-MX', dict)).toBe('Listo')
    expect(t('es-ES', dict)).toBe('Hecho')
    expect(t('ru', dict)).toBe('Готово')
  })

  it('язык вне словаря (pl) → en, без падения (§10)', () => {
    expect(t('pl', dict)).toBe('Done')
    expect(t('de', dict)).toBe('Done')
    expect(t(undefined, dict)).toBe('Done')
  })

  it('словарь функций-шаблонов', () => {
    const msg = t('es', { ru: (n: number) => `${n} шт.`, en: (n: number) => `${n} pcs`, es: (n: number) => `${n} uds.` })
    expect(msg(3)).toBe('3 uds.')
  })
})

describe('userLocaleInstruction', () => {
  it('называет язык на нём самом и тегом, требует рассуждать на нём же', () => {
    const text = userLocaleInstruction('es')
    expect(text).toContain('## Язык ответа')
    expect(text).toContain('Español (es)')
    expect(text).toContain('рассуждай')
  })

  it('несёт правило доменного контента: нормы и ссылки в оригинале', () => {
    const text = userLocaleInstruction('de')
    expect(text).toContain('СП, ГОСТ, ПУЭ')
    expect(text).toContain('«[название, пункт]»')
  })

  it('язык с регионом называется по базовому языку, тег — целиком', () => {
    expect(userLocaleInstruction('es-mx')).toContain('Español (es-MX)')
  })

  it('язык вне списка — тегом BCP-47', () => {
    expect(userLocaleInstruction('pl')).toContain('«pl»')
    expect(localeNativeName('pl')).toBeUndefined()
  })
})

describe('billingUserMessage по локали', () => {
  const state: BillingRuntimeState = {
    entitlementStatus: 'payment_failed',
    remainingTotalTokens: 0,
    llmKey: 'k',
    features: [],
    privileges: [],
  } as unknown as BillingRuntimeState

  it('у каждой причины и у общего текста есть все языки списка', () => {
    for (const dict of [...Object.values(BILLING_USER_MESSAGES_BY_LOCALE), DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE]) {
      expect(Object.keys(dict).sort()).toEqual([...TAGS].sort())
    }
  })

  it('без локали — русский, как раньше; старые экспорты совместимы', () => {
    expect(billingUserMessage('NO_TOKENS')).toBe(BILLING_USER_MESSAGES.NO_TOKENS)
    expect(BILLING_USER_MESSAGES.PAYMENT_FAILED).toContain('Платёж не прошёл')
    expect(DEFAULT_BILLING_USER_MESSAGE).toContain('подписку')
  })

  it('по причине и по ошибке — на языке локали', () => {
    expect(billingUserMessage('NO_TOKENS', 'es')).toBe(BILLING_USER_MESSAGES_BY_LOCALE.NO_TOKENS.es)
    const err = new BillingExecutionDeniedError(state)
    expect(err.reason).toBe('PAYMENT_FAILED')
    expect(friendlyBillingMessage(err, 'de')).toBe(BILLING_USER_MESSAGES_BY_LOCALE.PAYMENT_FAILED.de)
  })

  it('неизвестная причина — общий текст на языке локали', () => {
    expect(billingUserMessage(new Error('boom'), 'fr')).toBe(DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE.fr)
    expect(billingUserMessage('toString', 'pt')).toBe(DEFAULT_BILLING_USER_MESSAGE_BY_LOCALE.pt)
  })

  it('язык вне словаря (pl) → en; регион → язык (§10)', () => {
    expect(billingUserMessage('MISSING_FEATURE', 'pl')).toBe(BILLING_USER_MESSAGES_BY_LOCALE.MISSING_FEATURE.en)
    expect(billingUserMessage('MISSING_FEATURE', 'pt-BR')).toBe(BILLING_USER_MESSAGES_BY_LOCALE.MISSING_FEATURE.pt)
  })
})
