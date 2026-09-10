import type { AgentCard } from '@a2a-js/sdk'
import {
  AI37_ROUTING_EXTENSION_URI,
  buildAgentRoutingExtension,
  normalizeAgentRoutingProfile,
  type BillingExecutionRequirement,
} from '@ai37/agent-sdk'
import type { SkillIoSchemas, SkillProvider } from './types'

/**
 * Блок `x-ai37` карточки. Читатель — оркестратор (RemoteAgentRegistry chat-backend):
 * `skillsIo` — типизированный I/O скиллов (РЕШЕНИЕ 12); `skills[id].billing` — аддитивная
 * per-skill конвенция поверх агентного `x-ai37.billing` (канон «каждый скилл — привилегия»).
 */
export interface Ai37SkillsCardBlock {
  skills?: Record<string, { billing?: BillingExecutionRequirement }>
  skillsIo?: Record<string, SkillIoSchemas>
}

export type ComposedAgentCard = AgentCard & { 'x-ai37'?: Ai37SkillsCardBlock }

/**
 * Карточка агента, собранная из зарегистрированных скиллов: базовая карточка потребителя
 * (протокол, транспорт, security, его routing/v1-профиль) + записи `skills[]` в порядке
 * регистрации + вклады скиллов в routing/v1 + блок `x-ai37` (skillsIo / per-skill billing).
 *
 * С единственным скиллом, чья запись равна `base.skills[0]`, и без io/routing/billing
 * результат ПОЛНОСТЬЮ равен базовой карточке — «агент без дополнительных скиллов ничего
 * не меняет» (закреплено тестом).
 */
export function composeCardWithSkills(
  base: AgentCard,
  providers: readonly SkillProvider[],
): ComposedAgentCard {
  const card: ComposedAgentCard = { ...base, skills: providers.map((p) => p.card) }

  const extraDomains = providers.flatMap((p) => p.routing?.domains ?? [])
  const extraIntents = providers.flatMap((p) => p.routing?.intents ?? [])
  if (extraDomains.length > 0 || extraIntents.length > 0) {
    const extensions = base.capabilities?.extensions ?? []
    const existing = extensions.find((e) => e.uri === AI37_ROUTING_EXTENSION_URI)
    // Профиль нормализуется канонично (лимиты, известные интенты) — как buildAgentRoutingExtension.
    const baseProfile = existing
      ? normalizeAgentRoutingProfile(existing.params ?? { domains: [], intents: [], excludes: [] })
      : { domains: [], intents: [], excludes: [] }
    // Пре-дедуп ДО нормализации: канон проверяет лимит по сырой длине списка. Неизвестный
    // интент или переполнение лимита роняют композицию (fail-fast на старте агента).
    const merged = buildAgentRoutingExtension(
      normalizeAgentRoutingProfile({
        domains: dedupeCaseInsensitive([...baseProfile.domains, ...extraDomains]),
        intents: [...new Set([...baseProfile.intents, ...extraIntents])],
        excludes: baseProfile.excludes,
      }),
    )
    card.capabilities = {
      ...base.capabilities,
      extensions: existing
        ? extensions.map((e) => (e.uri === AI37_ROUTING_EXTENSION_URI ? merged : e))
        : [...extensions, merged],
    }
  }

  return withXAi37(card, providers)
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const key = value.toLocaleLowerCase('ru')
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

function withXAi37(
  card: ComposedAgentCard,
  providers: readonly SkillProvider[],
): ComposedAgentCard {
  const skillsBilling: NonNullable<Ai37SkillsCardBlock['skills']> = {}
  const skillsIo: NonNullable<Ai37SkillsCardBlock['skillsIo']> = {}
  for (const provider of providers) {
    if (provider.billing) skillsBilling[provider.id] = { billing: provider.billing }
    if (provider.io) skillsIo[provider.id] = provider.io
  }
  const xAi37: Ai37SkillsCardBlock = {
    ...(Object.keys(skillsBilling).length > 0 ? { skills: skillsBilling } : {}),
    ...(Object.keys(skillsIo).length > 0 ? { skillsIo } : {}),
  }
  if (Object.keys(xAi37).length > 0) card['x-ai37'] = xAi37

  return card
}
