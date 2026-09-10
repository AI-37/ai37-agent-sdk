import { describe, expect, it, vi } from 'vitest'
import type { AgentCard } from '@a2a-js/sdk'
import {
  buildAgentRoutingExtension,
  type AgentContext,
  type BillingExecutionRequirement,
} from '@ai37/agent-sdk'
import type { AgentInput, AgentRequest } from '../src/index'
import {
  buildSkillRegistryFromEnv,
  composeCardWithSkills,
  createSkillDispatchHandler,
  createSkillRegistry,
  loadSkillProvidersFromEnv,
  SKILL_STATE_KEY,
  SkillLoaderError,
  SkillRegistryError,
  type SkillProvider,
} from '../src/skills/index'

function makeProvider(id: string, overrides: Partial<SkillProvider> = {}): SkillProvider {
  return {
    id,
    card: { id, name: id, description: id, tags: [] },
    handler: { run: vi.fn(async () => ({ status: 'completed' as const, message: id })) },
    ...overrides,
  }
}

function makeReq(input: Partial<AgentInput> = {}, ctx?: AgentContext): AgentRequest {
  return {
    input: {
      text: 'обычный вопрос',
      data: {},
      metadata: {},
      taskId: 'task-1',
      contextId: 'ctx-1',
      negotiation: { text: 'text/plain', catalogIds: [], catalogId: null },
      ...input,
    },
    ctx,
    emit: () => {},
  }
}

const GATE: BillingExecutionRequirement = {
  privilege: 'norm-parameter-allowed',
} as unknown as BillingExecutionRequirement

describe('createSkillRegistry', () => {
  it('дефолтный скилл включён всегда, остальные — только из enabledSkillIds (fail-closed)', () => {
    const registry = createSkillRegistry(
      [makeProvider('search-docs'), makeProvider('norm-parameter'), makeProvider('other')],
      { defaultSkillId: 'search-docs', enabledSkillIds: ['norm-parameter'] },
    )
    expect(registry.all().map((p) => p.id)).toEqual(['search-docs', 'norm-parameter'])
    expect(registry.get('other')).toBeUndefined()
    expect(registry.defaultSkill().id).toBe('search-docs')
  })

  it('дубль id и расхождение id карточки — ошибки конфигурации', () => {
    expect(() =>
      createSkillRegistry([makeProvider('a'), makeProvider('a')], { defaultSkillId: 'a' }),
    ).toThrow(SkillRegistryError)
    const broken = makeProvider('a')
    broken.card = { ...broken.card, id: 'b' }
    expect(() => createSkillRegistry([broken], { defaultSkillId: 'a' })).toThrow(
      SkillRegistryError,
    )
  })

  it('неизвестный id в enabledSkillIds — ошибка (опечатка не должна тихо отключать скилл)', () => {
    expect(() =>
      createSkillRegistry([makeProvider('search-docs')], {
        defaultSkillId: 'search-docs',
        enabledSkillIds: ['norm-parametr'],
      }),
    ).toThrow(/norm-parametr/)
  })
})

describe('createSkillDispatchHandler — выбор скилла (РЕШЕНИЕ 8)', () => {
  function twoSkills(overrides: Partial<SkillProvider> = {}) {
    const search = makeProvider('search-docs')
    const norm = makeProvider('norm-parameter', overrides)
    const registry = createSkillRegistry([search, norm], {
      defaultSkillId: 'search-docs',
      enabledSkillIds: ['norm-parameter'],
    })
    return { search, norm, registry }
  }

  it('структурный intent.skill ведёт в названный скилл, минуя матчеры', async () => {
    const matcher = vi.fn(() => true)
    const search = makeProvider('search-docs', { matches: matcher })
    const norm = makeProvider('norm-parameter')
    const registry = createSkillRegistry([search, norm], {
      defaultSkillId: 'search-docs',
      enabledSkillIds: ['norm-parameter'],
    })
    const result = await createSkillDispatchHandler(registry).run(
      makeReq({ metadata: { intent: { skill: 'norm-parameter' } } }),
    )
    expect(result.message).toBe('norm-parameter')
    expect(search.handler.run).not.toHaveBeenCalled()
    expect(matcher).not.toHaveBeenCalled()
  })

  it('intent на недоступный скилл — явный failed, НЕ тихий откат в дефолт', async () => {
    const { search, registry } = twoSkills()
    const result = await createSkillDispatchHandler(registry).run(
      makeReq({ metadata: { intent: { skill: 'no-such-skill' } } }),
    )
    expect(result.status).toBe('failed')
    expect(result.message).toContain('no-such-skill')
    expect(search.handler.run).not.toHaveBeenCalled()
  })

  it('матчер берёт ход; упавший матчер = no-match (дефолт), ход не валится', async () => {
    const ok = twoSkills({ matches: () => true })
    expect(
      (await createSkillDispatchHandler(ok.registry).run(makeReq())).message,
    ).toBe('norm-parameter')

    const broken = twoSkills({
      matches: () => {
        throw new Error('classifier down')
      },
    })
    expect(
      (await createSkillDispatchHandler(broken.registry).run(makeReq())).message,
    ).toBe('search-docs')
  })

  it('многоходовка: state получает маркер владельца, следующий ход идёт ему без матчеров', async () => {
    const { registry } = twoSkills({
      handler: {
        run: async () => ({
          status: 'input-required' as const,
          message: 'вопрос',
          state: { wizard: { step: 1 } },
        }),
      },
    })
    const first = await createSkillDispatchHandler(registry).run(
      makeReq({ metadata: { intent: { skill: 'norm-parameter' } } }),
    )
    expect(first.state).toMatchObject({ [SKILL_STATE_KEY]: 'norm-parameter' })

    const cont = twoSkills()
    const second = await createSkillDispatchHandler(cont.registry).run(
      makeReq({ text: 'II', taskState: { [SKILL_STATE_KEY]: 'norm-parameter' } }),
    )
    expect(second.message).toBe('norm-parameter')
    expect(cont.search.handler.run).not.toHaveBeenCalled()
  })

  it('владелец state недоступен → ход маршрутизируется заново (дефолт), не падает', async () => {
    const search = makeProvider('search-docs')
    const registry = createSkillRegistry([search], { defaultSkillId: 'search-docs' })
    const result = await createSkillDispatchHandler(registry).run(
      makeReq({ text: 'II', taskState: { [SKILL_STATE_KEY]: 'norm-parameter' } }),
    )
    expect(result.message).toBe('search-docs')
  })

  it('per-skill биллинг: preflight с требованием скилла ДО handler-а; без ctx — fail-closed; отказ пробрасывается', async () => {
    const calls: string[] = []
    const ctx = {
      assertExecutionAllowed: vi.fn(async () => {
        calls.push('assert')
        return {}
      }),
    } as unknown as AgentContext
    const gated = twoSkills({
      billing: GATE,
      handler: {
        run: async () => {
          calls.push('handler')
          return { status: 'completed' as const }
        },
      },
    })
    await createSkillDispatchHandler(gated.registry).run(
      makeReq({ metadata: { intent: { skill: 'norm-parameter' } } }, ctx),
    )
    expect(ctx.assertExecutionAllowed).toHaveBeenCalledWith(GATE)
    expect(calls).toEqual(['assert', 'handler'])

    const noCtx = await createSkillDispatchHandler(gated.registry).run(
      makeReq({ metadata: { intent: { skill: 'norm-parameter' } } }),
    )
    expect(noCtx.status).toBe('failed')

    const denyCtx = {
      assertExecutionAllowed: vi.fn(async () => {
        throw new Error('execution denied')
      }),
    } as unknown as AgentContext
    await expect(
      createSkillDispatchHandler(gated.registry).run(
        makeReq({ metadata: { intent: { skill: 'norm-parameter' } } }, denyCtx),
      ),
    ).rejects.toThrow('execution denied')
  })

  it('скилл без billing идёт без preflight диспетчера', async () => {
    const ctx = { assertExecutionAllowed: vi.fn() } as unknown as AgentContext
    const registry = createSkillRegistry([makeProvider('search-docs')], {
      defaultSkillId: 'search-docs',
    })
    await createSkillDispatchHandler(registry).run(makeReq({}, ctx))
    expect(ctx.assertExecutionAllowed).not.toHaveBeenCalled()
  })
})

describe('composeCardWithSkills', () => {
  const baseProfile = {
    domains: ['нормативные документы'],
    intents: ['document_search' as const],
    excludes: [],
  }

  function baseCard(): AgentCard {
    return {
      protocolVersion: '0.3',
      name: 'Test Agent',
      description: 'test',
      version: '0.0.0',
      url: 'http://localhost/a2a/v1',
      preferredTransport: 'JSONRPC',
      capabilities: { streaming: true, extensions: [buildAgentRoutingExtension(baseProfile)] },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'search-docs', name: 'Search', description: 'поиск', tags: [] }],
    }
  }

  it('с единственным скиллом, равным базовому, карточка не меняется (и без блока x-ai37)', () => {
    const base = baseCard()
    const composed = composeCardWithSkills(base, [
      makeProvider('search-docs', { card: base.skills[0] }),
    ])
    expect(composed).toEqual(base)
    expect('x-ai37' in composed).toBe(false)
  })

  it('вклад скилла мержится в routing/v1 с дедупликацией; записи skills[] в порядке регистрации', () => {
    const base = baseCard()
    const composed = composeCardWithSkills(base, [
      makeProvider('search-docs', { card: base.skills[0] }),
      makeProvider('norm-parameter', {
        routing: {
          domains: ['нормативные документы', 'пожарная безопасность'],
          intents: ['normative_qa'],
        },
      }),
    ])
    expect(composed.skills.map((s) => s.id)).toEqual(['search-docs', 'norm-parameter'])
    const params = composed.capabilities?.extensions?.[0]?.params as {
      domains: string[]
      intents: string[]
    }
    expect(params.domains).toEqual(['нормативные документы', 'пожарная безопасность'])
    expect(params.intents).toEqual(['document_search', 'normative_qa'])
  })

  it('per-skill биллинг и skillsIo уезжают в блок x-ai37', () => {
    const base = baseCard()
    const io = { input: { type: 'object' }, output: { type: 'object' } }
    const composed = composeCardWithSkills(base, [
      makeProvider('search-docs', { card: base.skills[0] }),
      makeProvider('norm-parameter', { io, billing: GATE }),
    ])
    expect(composed['x-ai37']).toEqual({
      skills: { 'norm-parameter': { billing: GATE } },
      skillsIo: { 'norm-parameter': io },
    })
  })

  it('неизвестный интент вклада роняет композицию (fail-fast канона routing/v1)', () => {
    const base = baseCard()
    expect(() =>
      composeCardWithSkills(base, [
        makeProvider('search-docs', { card: base.skills[0] }),
        makeProvider('norm-parameter', { routing: { intents: ['не-из-энума'] } }),
      ]),
    ).toThrow(/unsupported routing intent/)
  })
})

describe('loader — модули из env', () => {
  const FIXTURE = './test/fixtures/fake-skill-module.mjs'
  const BROKEN = './test/fixtures/broken-skill-module.mjs'

  it('пустой AGENT_SKILL_MODULES → пусто; модуль по пути импортируется', async () => {
    await expect(loadSkillProvidersFromEnv({})).resolves.toEqual([])
    const providers = await loadSkillProvidersFromEnv({ AGENT_SKILL_MODULES: FIXTURE })
    expect(providers.map((p) => p.id)).toEqual(['fixture-skill'])
  })

  it('несуществующий модуль и не-SkillProvider-экспорт — ошибки загрузчика (fail-fast)', async () => {
    await expect(
      loadSkillProvidersFromEnv({ AGENT_SKILL_MODULES: './no/such/module.mjs' }),
    ).rejects.toThrow(SkillLoaderError)
    await expect(loadSkillProvidersFromEnv({ AGENT_SKILL_MODULES: BROKEN })).rejects.toThrow(
      /broken-skill-module/,
    )
  })

  it('buildSkillRegistryFromEnv: встроенные включены всегда, модуль — только через AGENT_ENABLED_SKILLS', async () => {
    const builtin = [makeProvider('search-docs'), makeProvider('secondary')]
    const off = await buildSkillRegistryFromEnv({
      builtin,
      env: { AGENT_SKILL_MODULES: FIXTURE },
    })
    expect(off.all().map((p) => p.id)).toEqual(['search-docs', 'secondary'])
    expect(off.get('fixture-skill')).toBeUndefined()

    const on = await buildSkillRegistryFromEnv({
      builtin,
      env: { AGENT_SKILL_MODULES: FIXTURE, AGENT_ENABLED_SKILLS: 'fixture-skill' },
    })
    expect(on.all().map((p) => p.id)).toEqual(['search-docs', 'secondary', 'fixture-skill'])
    expect(on.defaultSkill().id).toBe('search-docs')
  })

  it('включение неподключённого id — ошибка конфигурации', async () => {
    await expect(
      buildSkillRegistryFromEnv({
        builtin: makeProvider('search-docs'),
        env: { AGENT_ENABLED_SKILLS: 'norm-parameter' },
      }),
    ).rejects.toThrow(SkillRegistryError)
  })
})
