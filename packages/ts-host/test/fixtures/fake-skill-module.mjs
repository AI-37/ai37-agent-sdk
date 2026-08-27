// Фикстура skills.test.ts: модуль скилла в форме, которую ждёт AGENT_SKILL_MODULES.
// .mjs — загрузчик импортирует НАТИВНЫМ import(); .ts-пути работают только под tsx-рантаймом.
export const skillProviders = [
  {
    id: 'fixture-skill',
    card: {
      id: 'fixture-skill',
      name: 'Fixture skill',
      description: 'Тестовый скилл для skills.test.ts',
      tags: [],
    },
    handler: { run: async () => ({ status: 'completed' }) },
  },
]
