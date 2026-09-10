import type { AgentCard } from '@a2a-js/sdk'
import type { BillingExecutionRequirement } from '@ai37/agent-sdk'
import type { AgentHandler, AgentInput } from '../types'

/**
 * Скиллы агента — генерик-механизм хоста (перенос из document-service по ревью:
 * кастомные скиллы нужны ВСЕМ агентам, а не одному потребителю).
 *
 * Агент собирается из скиллов: единиц каталога (запись карточки), диспетчеризации
 * (интент/матчер), биллинга (per-skill требование) и когниции (handler). Хост несёт
 * контракт и механику; доменные скиллы живут у потребителей (репозиторий агента или его
 * продуктовый форк) и подключаются кодом или через env-загрузчик (loader.ts).
 */

/** Запись `card.skills[]` A2A-карточки (тип элемента из @a2a-js/sdk). */
export type SkillCardEntry = AgentCard['skills'][number]

/**
 * Настоящие JSON Schema входа/выхода скилла → `x-ai37.skillsIo[id]` карточки
 * (типизированный I/O, ecosystem РЕШЕНИЕ 12).
 */
export interface SkillIoSchemas {
  input?: Record<string, unknown>
  output?: Record<string, unknown>
}

/**
 * Вклад скилла в routing/v1-профиль карточки: домены/интенты ДОБАВЛЯЮТСЯ к профилю
 * агента; excludes скилл не задаёт — это свойство агента. intents — СТРОГО из
 * канонического реестра AI37_ROUTING_INTENTS: неизвестный интент роняет композицию
 * карточки на старте агента (fail-fast каноничных хелперов routing/v1).
 */
export interface SkillRoutingContribution {
  domains?: string[]
  intents?: string[]
}

/**
 * Скилл агента. Диспетчеризация — двухрежимный intent (ecosystem РЕШЕНИЕ 8, конверт
 * `metadata.ai37.intent` уже распарсен хостом в `input.metadata.intent`):
 *  1. структурный `intent.skill === id` → handler без LLM-классификации;
 *  2. продолжение многоходовки — владелец state (см. dispatch.ts, SKILL_STATE_KEY);
 *  3. иначе первый скилл, чей `matches(input)` вернул true (порядок регистрации);
 *  4. иначе — дефолтный скилл агента.
 */
export interface SkillProvider {
  /** id скилла: ключ диспетчеризации и `card.skills[].id`. Уникален в реестре. */
  id: string
  /**
   * Запись карточки (`entry.id` обязан равняться `id` — проверяет реестр). Тексты записи
   * подчиняются инварианту продуктовой нейтральности карточки агента-потребителя:
   * описывать ФОРМУ работы скилла, предметная область — по составу данных инстанса.
   */
  card: SkillCardEntry
  /** JSON Schema входа/выхода → `x-ai37.skillsIo[id]` (см. SkillIoSchemas). */
  io?: SkillIoSchemas
  /** Вклад в routing/v1-профиль карточки (см. SkillRoutingContribution). */
  routing?: SkillRoutingContribution
  /**
   * Per-skill требование доступа. Диспетчер делает preflight
   * `ctx.assertExecutionAllowed(billing)` ПЕРЕД handler-ом (fail-closed), а карточка несёт
   * его в `x-ai37.skills[id].billing` — оркестратор фильтрует каталог по подписке
   * (двойной барьер: каталог + preflight). Нет требования → диспетчер preflight не делает;
   * скилл может ассертить сам внутри handler-а.
   */
  billing?: BillingExecutionRequirement
  /**
   * Текстовый матчер (режим 3 диспетчеризации): решает по сырому входу, берёт ли скилл
   * ход, когда структурный intent скилла не назвал. Должен быть ЛЁГКИМ и детерминированным
   * (regex/словарь; максимум — дешёвый классификатор), не полноценным LLM-ходом: он стоит
   * на пути КАЖДОГО текстового запроса к агенту. Ошибка матчера не валит ход — no-match.
   */
  matches?: (input: AgentInput) => boolean | Promise<boolean>
  /** Когниция скилла — тот же контракт, что у корневого handler-а агента. */
  handler: AgentHandler
}
