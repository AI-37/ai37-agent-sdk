import type { AgentHandler, AgentRequest, AgentResult } from '../types'
import type { SkillRegistry } from './registry'
import type { SkillProvider } from './types'

/**
 * Маркер владельца многоходовки в `AgentResult.state`: диспетчер дописывает его к state
 * скилла на `input-required` и на следующем ходу возвращает ход владельцу БЕЗ интента и
 * матчеров — ответ пользователя на вопрос визарда («II», «да») по тексту не
 * маршрутизируется. Для скилла ключ прозрачен (лишнее поле в taskState).
 */
export const SKILL_STATE_KEY = '__ai37_skill'

/**
 * Корневой handler агента: выбирает скилл и передаёт ему ход как есть (`AgentRequest`
 * не переупаковывается — контракт скилла тот же, что у корневого handler-а).
 *
 * Порядок выбора — двухрежимный intent (ecosystem РЕШЕНИЕ 8):
 *  1. структурный `metadata.ai37.intent.skill` (уже распарсен хостом) — ветка без LLM;
 *     intent на незарегистрированный/выключенный скилл → явный failed, НЕ тихий откат в
 *     дефолт: молчаливая деградация маскирует ошибку контракта вызывающего и обходит
 *     смысл per-skill гейта;
 *  2. продолжение многоходовки: `taskState` прошлого хода несёт владельца (SKILL_STATE_KEY) —
 *     ход возвращается ему;
 *  3. сырой текст → лёгкие матчеры скиллов в порядке регистрации (ошибка матчера = no-match,
 *     ход не валится);
 *  4. дефолтный скилл.
 *
 * Preflight биллинга: у скилла с `billing` требование ассертится ЗДЕСЬ, до handler-а
 * (fail-closed; отказ биллинга пробрасывается — хост маппит его в failed-статус A2A).
 * Скилл без `billing` идёт без preflight — его политика внутри handler-а.
 */
export function createSkillDispatchHandler(registry: SkillRegistry): AgentHandler {
  return {
    async run(req: AgentRequest): Promise<AgentResult> {
      const skill = await selectSkill(registry, req)
      if (typeof skill === 'string') {
        return {
          status: 'failed',
          message: `Запрошенный скилл «${skill}» недоступен у этого агента.`,
        }
      }

      if (skill.billing) {
        if (!req.ctx) {
          // Гейтованный скилл без verified-контекста невыполним по определению — fail-closed.
          return {
            status: 'failed',
            message: 'Скилл требует авторизованного доступа, а ход пришёл без него.',
          }
        }
        await req.ctx.assertExecutionAllowed(skill.billing)
      }

      const result = await skill.handler.run(req)
      // Многоходовка: пометить владельца state, чтобы следующий ход task вернулся ему же.
      if (result.status === 'input-required' && result.state !== undefined) {
        return { ...result, state: { ...result.state, [SKILL_STATE_KEY]: skill.id } }
      }
      return result
    },
  }
}

/** Выбор скилла по порядку intent → владелец state → матчеры → дефолт; строка = id недоступного скилла. */
async function selectSkill(
  registry: SkillRegistry,
  req: AgentRequest,
): Promise<SkillProvider | string> {
  const requested = req.input.metadata.intent?.skill
  if (requested !== undefined && requested !== '') {
    return registry.get(requested) ?? requested
  }

  // Продолжение многоходовки: state прошлого хода несёт владельца (см. SKILL_STATE_KEY).
  const stateOwner = (req.input.taskState as Record<string, unknown> | undefined)?.[
    SKILL_STATE_KEY
  ]
  if (typeof stateOwner === 'string' && stateOwner !== '') {
    const owner = registry.get(stateOwner)
    if (owner) return owner
    console.warn(
      `[agent-host:skills] владелец state «${stateOwner}» недоступен — ход маршрутизируется заново`,
    )
  }

  const defaultSkill = registry.defaultSkill()
  for (const provider of registry.all()) {
    if (provider.id === defaultSkill.id || !provider.matches) continue
    try {
      if (await provider.matches(req.input)) return provider
    } catch (error) {
      console.warn(
        `[agent-host:skills] матчер скилла «${provider.id}» упал (считаю no-match): ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return defaultSkill
}
