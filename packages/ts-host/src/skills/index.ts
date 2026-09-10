// @ai37/agent-host/skills — генерик-механизм скиллов агента (subpath, как /relay).
//
// Агент = скиллы: запись карточки + typed I/O + routing-вклад + per-skill биллинг +
// матчер + handler (types.ts). Реестр валидирует и включает (registry.ts), диспетчер
// ведёт ход по двухрежимному intent с многоходовкой и биллинг-preflight (dispatch.ts),
// карточка собирается из скиллов с блоком x-ai37 (compose-card.ts), env-загрузчик
// подключает доменные модули инстанса без правки кода агента (loader.ts).
//
// Потребление (образец — document-service):
//   const registry = await buildSkillRegistryFromEnv({ builtin: createSearchDocsSkill() })
//   createAgentHost({
//     card: composeCardWithSkills(buildAgentCard(baseUrl), registry.all()),
//     handler: createSkillDispatchHandler(registry),
//     ...
//   })
export type {
  SkillCardEntry,
  SkillIoSchemas,
  SkillProvider,
  SkillRoutingContribution,
} from './types'
export {
  createSkillRegistry,
  SkillRegistryError,
  type SkillRegistry,
  type SkillRegistryOptions,
} from './registry'
export { createSkillDispatchHandler, SKILL_STATE_KEY } from './dispatch'
export {
  composeCardWithSkills,
  type Ai37SkillsCardBlock,
  type ComposedAgentCard,
} from './compose-card'
export {
  buildSkillRegistryFromEnv,
  loadSkillProvidersFromEnv,
  SkillLoaderError,
  ENABLED_SKILLS_ENV,
  SKILL_MODULES_ENV,
  type BuildSkillRegistryOptions,
  type SkillLoaderEnv,
} from './loader'
