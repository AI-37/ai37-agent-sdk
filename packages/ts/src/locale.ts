// Локаль пользователя: список поддерживаемых языков, цепочка фолбэков, разрешение локали хода.
// Контракт — docs `ecosystem/v2.4/06-i18n-locale.md` (план docs#589, §3.1). Паритет с Python
// `ai37_agent_sdk.locale`.

/** Запись списка поддерживаемых языков. */
export interface SupportedLocale {
  /** Тег BCP-47 (`язык[-регион][-вариант]`), канонический регистр. */
  readonly tag: string
  /** Название языка на нём самом — для переключателя языка и инструкции LLM. */
  readonly nativeName: string
  /**
   * Куда идти за строкой, если в словаре нет этого языка (задел: `ca` → `es`). Не задан — сразу `en`.
   */
  readonly fallback?: string
}

/**
 * Поддерживаемые языки. Это данные, а не тип: новый язык добавляется строкой здесь и словарями, без
 * правки кода разрешения. `es` — европейский испанский, `pt` — бразильский португальский.
 */
export const SUPPORTED_LOCALES: readonly SupportedLocale[] = Object.freeze([
  { tag: 'ru', nativeName: 'Русский' },
  { tag: 'en', nativeName: 'English' },
  { tag: 'es', nativeName: 'Español' },
  { tag: 'de', nativeName: 'Deutsch' },
  { tag: 'fr', nativeName: 'Français' },
  { tag: 'pt', nativeName: 'Português' },
])

/** Конец любой цепочки фолбэков и язык для всего, чего нет в списке (решение В8). */
export const FALLBACK_LOCALE = 'en'

/**
 * Локаль хода, когда её не передал ни конверт, ни токен. Русский — только обратная совместимость:
 * так клиенты, которые локаль ещё не шлют, получают прежнее поведение.
 */
export const LEGACY_DEFAULT_LOCALE = 'ru'

/** Словарь детерминированной строки по языкам; `en` обязателен — им кончается цепочка. */
export type LocaleDict<T> = { readonly en: T } & { readonly [tag: string]: T }

const LOCALE_TAG = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i

/** Регистр подтега по BCP-47: язык строчными, письменность с заглавной, регион прописными. */
function canonicalSubtag(subtag: string, index: number): string {
  if (index === 0) return subtag.toLowerCase()
  if (subtag.length === 4 && /^[a-z]+$/i.test(subtag)) {
    return subtag[0]!.toUpperCase() + subtag.slice(1).toLowerCase()
  }
  if (/^([a-z]{2}|\d{3})$/i.test(subtag)) return subtag.toUpperCase()
  return subtag.toLowerCase()
}

/**
 * Тег BCP-47 в каноническом регистре (`ES-mx` → `es-MX`, `_` → `-`) или `undefined`, если это не тег.
 * Тег не обрезается: `ca-ES-valencia` остаётся целиком.
 */
export function canonicalLocaleTag(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim().replace(/_/g, '-')
  if (!LOCALE_TAG.test(raw)) return undefined
  return raw.split('-').map(canonicalSubtag).join('-')
}

function findSupported(tag: string): SupportedLocale | undefined {
  return SUPPORTED_LOCALES.find((l) => l.tag.toLowerCase() === tag.toLowerCase())
}

/** `ca-ES-valencia` → `['ca-ES-valencia', 'ca-ES', 'ca']`. */
function tagPrefixes(tag: string): string[] {
  const parts = tag.split('-')
  return parts.map((_, i) => parts.slice(0, parts.length - i).join('-'))
}

/**
 * Цепочка вариантов, которые локаль объявляет сама: точный тег → тег без варианта и региона →
 * объявленный `fallback` (со своими префиксами). Без `en` в конце: им кончается {@link localeChain},
 * а у переведённых вариантов карточки запасной вариант свой — русская база. Невалидная или пустая
 * локаль → `[]`.
 */
export function localeVariantChain(locale: string | undefined): string[] {
  const chain: string[] = []
  let next = canonicalLocaleTag(locale)
  while (next && !chain.includes(next)) {
    const prefixes = tagPrefixes(next).filter((t) => !chain.includes(t))
    chain.push(...prefixes)
    next = prefixes.map((t) => findSupported(t)?.fallback).find(Boolean)
    next = canonicalLocaleTag(next)
  }
  return chain
}

/**
 * Цепочка поиска строки для локали: точный тег → тег без варианта и региона → объявленный `fallback`
 * (со своими префиксами) → `en`. Невалидная или пустая локаль → `['en']`.
 */
export function localeChain(locale: string | undefined): string[] {
  const chain = localeVariantChain(locale)
  if (!chain.includes(FALLBACK_LOCALE)) chain.push(FALLBACK_LOCALE)
  return chain
}

/**
 * Вариант для локали из словаря `тег → вариант` по {@link localeVariantChain}: `es-MX` найдёт `es`.
 * Ничего не нашлось — `undefined`, и вызывающий берёт свою базу: у карточек агентов это русские поля,
 * поэтому язык вне словаря (`pl`) видит русский текст, а не английский. Ключи словаря сравниваются
 * по каноническому тегу, так что `es-mx` в словаре тоже найдётся.
 */
export function pickLocaleVariant<T>(
  variants: Readonly<Record<string, T>> | null | undefined,
  locale: string | undefined,
): T | undefined {
  if (!variants) return undefined
  const byTag = new Map<string, T>()
  for (const [key, value] of Object.entries(variants)) {
    const tag = canonicalLocaleTag(key)
    if (tag && !byTag.has(tag) && value !== undefined) byTag.set(tag, value)
  }
  const found = localeVariantChain(locale).find((tag) => byTag.has(tag))
  return found === undefined ? undefined : byTag.get(found)
}

/**
 * Поддерживаемая локаль для значения из браузера, профиля или конверта (решение В8): первый тег цепочки
 * из `SUPPORTED_LOCALES`; всё вне списка и пустое — `en`. Тег из списка возвращается как есть, без
 * обрезки до языка (`es-MX` останется `es-MX`, когда появится в списке).
 */
export function normalizeLocale(locale: string | undefined): string {
  for (const tag of localeChain(locale)) {
    const supported = findSupported(tag)
    if (supported) return supported.tag
  }
  return FALLBACK_LOCALE
}

/** Claims, из которых берётся локаль (подмножество `Claims`). */
export interface LocaleClaims {
  locale?: unknown
  org_locale?: unknown
}

function explicitLocale(value: unknown): string | undefined {
  // `auto` в профиле значит «как в браузере»: это не язык, а его отсутствие.
  if (typeof value === 'string' && value.trim().toLowerCase() === 'auto') return undefined
  return canonicalLocaleTag(value)
}

/**
 * Локаль хода для бэкенда и агентов: `metadata.ai37.locale` → claim `locale` → claim `org_locale` →
 * `ru`. Значение не сводится к списку поддерживаемых: агент с локалью `pl` всё равно отвечает LLM
 * по-польски, а детерминированные строки `t()` возьмёт из `en`. Невалидное значение пропускается.
 */
export function resolveRequestLocale(
  metadataLocale: unknown,
  claims?: LocaleClaims | null,
): string {
  return (
    explicitLocale(metadataLocale) ??
    explicitLocale(claims?.locale) ??
    explicitLocale(claims?.org_locale) ??
    LEGACY_DEFAULT_LOCALE
  )
}

/**
 * Детерминированная строка агента на языке локали по цепочке {@link localeChain}. `T` может быть и
 * функцией-шаблоном: `t(locale, { ru: (n) => …, en: (n) => … })(n)`.
 */
export function t<T>(locale: string | undefined, dict: LocaleDict<T>): T {
  const byTag = dict as Readonly<Record<string, T>>
  const key = localeChain(locale).find((tag) => byTag[tag] !== undefined)
  return key !== undefined ? byTag[key]! : dict.en
}

/** Название языка на нём самом или `undefined`, если языка нет в {@link SUPPORTED_LOCALES}. */
export function localeNativeName(locale: string | undefined): string | undefined {
  for (const tag of tagPrefixes(canonicalLocaleTag(locale) ?? '')) {
    const supported = findSupported(tag)
    if (supported) return supported.nativeName
  }
  return undefined
}

/**
 * Секция системного промпта о языке ответа и доменном контенте (docs#589 §1). Промпт остаётся на
 * русском: язык промпта и язык ответа — разные вещи. Язык вне списка называется тегом BCP-47.
 */
export function userLocaleInstruction(locale: string): string {
  const tag = canonicalLocaleTag(locale) ?? LEGACY_DEFAULT_LOCALE
  const name = localeNativeName(tag)
  const language = name ? `${name} (${tag})` : `язык с тегом BCP-47 «${tag}»`
  return [
    '## Язык ответа',
    `Отвечай пользователю на языке: ${language} — даже если вопрос, контекст или документы на другом языке. ` +
      'По возможности рассуждай на этом же языке.',
    'Всё, что относится к документам, оставляй на языке документа: цитаты норм (СП, ГОСТ, ПУЭ и др.), ' +
      'названия и номера документов, номера пунктов, ссылки вида «[название, пункт]». ' +
      'Пояснения к ним пиши на языке ответа.',
  ].join('\n')
}
