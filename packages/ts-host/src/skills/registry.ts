import type { SkillProvider } from './types'

/**
 * Реестр скиллов агента: валидация + фильтр включения.
 *
 * Ошибки конфигурации (дубль id, расхождение id записи карточки, неизвестный id в списке
 * включённых) роняют композицию агента на старте процесса, не ход пользователя: молчаливо
 * «потерянный» из-за опечатки скилл хуже падения при деплое.
 */

export class SkillRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillRegistryError'
  }
}

export interface SkillRegistryOptions {
  /** id дефолтного скилла (ветка «ни intent, ни матчер не выбрали»). Обязан быть в providers. */
  defaultSkillId: string
  /**
   * Список включённых скиллов (env-гейт, см. loader.ts). Дефолтный скилл включён ВСЕГДА;
   * остальные — только из списка (fail-closed: «каждый новый скилл — привилегия»).
   * null/undefined → включён только дефолтный.
   */
  enabledSkillIds?: readonly string[] | null
}

export interface SkillRegistry {
  /** Включённые скиллы в порядке регистрации (дефолтный — в своей позиции). */
  all(): readonly SkillProvider[]
  /** Включённый скилл по id; выключенный или незарегистрированный → undefined. */
  get(id: string): SkillProvider | undefined
  defaultSkill(): SkillProvider
}

export function createSkillRegistry(
  providers: readonly SkillProvider[],
  options: SkillRegistryOptions,
): SkillRegistry {
  const byId = new Map<string, SkillProvider>()
  for (const provider of providers) {
    if (!provider.id || provider.id.trim() === '') {
      throw new SkillRegistryError('скилл с пустым id')
    }
    if (byId.has(provider.id)) {
      throw new SkillRegistryError(`дубль id скилла «${provider.id}»`)
    }
    if (provider.card.id !== provider.id) {
      throw new SkillRegistryError(
        `скилл «${provider.id}»: id записи карточки «${provider.card.id}» не совпадает`,
      )
    }
    byId.set(provider.id, provider)
  }

  const { defaultSkillId } = options
  if (!byId.has(defaultSkillId)) {
    throw new SkillRegistryError(`дефолтный скилл «${defaultSkillId}» не зарегистрирован`)
  }

  const enabledIds = new Set<string>([defaultSkillId])
  for (const id of options.enabledSkillIds ?? []) {
    if (!byId.has(id)) {
      throw new SkillRegistryError(
        `включён незарегистрированный скилл «${id}» (опечатка или модуль не подключён?)`,
      )
    }
    enabledIds.add(id)
  }

  const enabled = [...byId.values()].filter((p) => enabledIds.has(p.id))

  return {
    all: () => enabled,
    get: (id) => (enabledIds.has(id) ? byId.get(id) : undefined),
    defaultSkill: () => byId.get(defaultSkillId)!,
  }
}
