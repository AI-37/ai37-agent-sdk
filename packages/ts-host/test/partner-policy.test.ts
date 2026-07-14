import { describe, it, expect } from 'vitest'
import {
  requestScope,
  currentPartnerInstructions,
  withPartnerInstructions,
} from '../src/als'

/**
 * Партнёрская инструкция (metadata.ai37.instructions) применяется ВИДИМО: агент дописывает её
 * `withPartnerInstructions(systemPrompt)` отдельной секцией в конец своего system-промпта ДО invoke,
 * поэтому она попадает и в реальный LLM-запрос, и в Langfuse-трейс. Значение берётся из request-scope
 * (host кладёт его из ai37: A2A-guard + AG-UI-роутер).
 */
describe('withPartnerInstructions (видимое применение политики владельца)', () => {
  const base = 'Ты ассистент. Извлеки поля из сообщения.'

  it('нет scope → промпт без изменений (та же строка)', () => {
    expect(withPartnerInstructions(base)).toBe(base)
  })

  it('scope без instructions → без изменений', () => {
    requestScope.run({}, () => {
      expect(withPartnerInstructions(base)).toBe(base)
      expect(currentPartnerInstructions()).toBeUndefined()
    })
  })

  it('scope с instructions → дописывает секцию В КОНЕЦ промпта', () => {
    requestScope.run({ instructions: 'скорость 5 м/с' }, () => {
      const out = withPartnerInstructions(base)
      expect(out.startsWith(base)).toBe(true) // базовый промпт сохранён и идёт первым
      expect(out).toContain('## Инструкция владельца')
      expect(out).toContain('скорость 5 м/с')
      expect(out.indexOf('скорость 5 м/с')).toBeGreaterThan(base.length) // секция именно в конце
    })
  })

  it('пустая/пробельная строка instructions → без изменений', () => {
    requestScope.run({ instructions: '   ' }, () => {
      expect(withPartnerInstructions(base)).toBe(base)
    })
  })
})
