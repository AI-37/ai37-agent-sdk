import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSkillRegistry, type SkillRegistry } from './registry'
import type { SkillProvider } from './types'

/**
 * Загрузчик скиллов из окружения — шов, которым инстанс агента (продуктовый форк, деплой)
 * подключает свои доменные скиллы, не меняя код агента:
 *
 *  - `AGENT_SKILL_MODULES` — список модулей через запятую (путь от корня процесса или
 *    bare-имя пакета). Модуль экспортирует (named `skillProviders` или default) массив
 *    `SkillProvider`, один провайдер или (async-)фабрику того и другого.
 *    Пример: `AGENT_SKILL_MODULES=./src/skills/norm-parameter/register.ts` (пути .ts
 *    работают под tsx-рантаймом; иначе — .js/.mjs или имя пакета).
 *  - `AGENT_ENABLED_SKILLS` — id включаемых скиллов через запятую (fail-closed: без
 *    включения зарегистрированный скилл не активен; дефолтный скилл включён всегда).
 *
 * Ошибка загрузки/валидации роняет старт процесса (fail-fast), не ход пользователя.
 */

export class SkillLoaderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillLoaderError'
  }
}

export const SKILL_MODULES_ENV = 'AGENT_SKILL_MODULES'
export const ENABLED_SKILLS_ENV = 'AGENT_ENABLED_SKILLS'

/** Значения окружения, которые читает загрузчик (сужение process.env — удобно в тестах). */
export type SkillLoaderEnv = Record<string, string | undefined>

function parseList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** Спецификатор модуля: путь (./, ../, /) → file-URL от корня процесса; иначе bare-имя пакета. */
function resolveSpecifier(spec: string): string {
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    return pathToFileURL(path.resolve(process.cwd(), spec)).href
  }
  return spec
}

function isSkillProvider(value: unknown): value is SkillProvider {
  if (typeof value !== 'object' || value === null) return false
  const p = value as Partial<SkillProvider>
  return (
    typeof p.id === 'string' &&
    typeof p.card === 'object' &&
    p.card !== null &&
    typeof p.handler === 'object' &&
    p.handler !== null &&
    typeof p.handler.run === 'function'
  )
}

async function normalizeModuleExport(spec: string, exported: unknown): Promise<SkillProvider[]> {
  const value = typeof exported === 'function' ? await (exported as () => unknown)() : exported
  const list = Array.isArray(value) ? value : [value]
  for (const item of list) {
    if (!isSkillProvider(item)) {
      throw new SkillLoaderError(
        `${SKILL_MODULES_ENV}: модуль «${spec}» экспортировал не SkillProvider (нужны id, card, handler.run)`,
      )
    }
  }
  return list as SkillProvider[]
}

/** Динамически импортирует модули скиллов из `AGENT_SKILL_MODULES` (пустой env → []). */
export async function loadSkillProvidersFromEnv(
  env: SkillLoaderEnv = process.env,
): Promise<SkillProvider[]> {
  const providers: SkillProvider[] = []
  for (const spec of parseList(env[SKILL_MODULES_ENV])) {
    let mod: Record<string, unknown>
    try {
      mod = (await import(/* @vite-ignore */ resolveSpecifier(spec))) as Record<string, unknown>
    } catch (error) {
      throw new SkillLoaderError(
        `${SKILL_MODULES_ENV}: не удалось импортировать модуль «${spec}»: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    const exported = mod.skillProviders ?? mod.default
    if (exported === undefined) {
      throw new SkillLoaderError(
        `${SKILL_MODULES_ENV}: модуль «${spec}» не экспортирует ни skillProviders, ни default`,
      )
    }
    providers.push(...(await normalizeModuleExport(spec, exported)))
  }
  return providers
}

export interface BuildSkillRegistryOptions {
  /** Встроенные скиллы агента; ПЕРВЫЙ — дефолтный (ветка «никто не выбран»). */
  builtin: SkillProvider | readonly SkillProvider[]
  env?: SkillLoaderEnv
}

/**
 * Реестр скиллов агента: встроенные скиллы потребителя + модули из env. Дальше потребитель
 * собирает карточку (`composeCardWithSkills(base, registry.all())`) и корневой handler
 * (`createSkillDispatchHandler(registry)`).
 */
export async function buildSkillRegistryFromEnv(
  options: BuildSkillRegistryOptions,
): Promise<SkillRegistry> {
  const builtin = Array.isArray(options.builtin)
    ? (options.builtin as readonly SkillProvider[])
    : [options.builtin as SkillProvider]
  if (builtin.length === 0) {
    throw new SkillLoaderError('нужен хотя бы один встроенный скилл (первый — дефолтный)')
  }
  const env = options.env ?? process.env
  const loaded = await loadSkillProvidersFromEnv(env)
  return createSkillRegistry([...builtin, ...loaded], {
    defaultSkillId: builtin[0].id,
    // Встроенные скиллы включены всегда — env-гейт управляет только подключаемыми модулями.
    enabledSkillIds: [
      ...builtin.slice(1).map((p) => p.id),
      ...parseList(env[ENABLED_SKILLS_ENV]),
    ],
  })
}
