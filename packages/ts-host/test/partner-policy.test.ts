import { describe, it, expect } from 'vitest'
import { SystemMessage, HumanMessage } from '@langchain/core/messages'
import { requestScope, currentPartnerInstructions } from '../src/als'
import { withPartnerPolicy } from '../src/ai37-chat-completions'

/**
 * Авто-инъекция политики владельца (metadata.ai37.instructions) в LLM-вызовы: `Ai37ChatCompletions`
 * зовёт `withPartnerPolicy` в `_generate`/`_streamResponseChunks`, читая инструкцию из request-scope.
 * Так политика работает на ВСЕХ агентах, использующих модель, без их правок.
 */
describe('withPartnerPolicy (авто-инъекция политики владельца)', () => {
  const base = () => [new SystemMessage('extract fields'), new HumanMessage('посчитай на 2.5')]

  it('нет scope → массив без изменений (та же ссылка)', () => {
    const msgs = base()
    expect(withPartnerPolicy(msgs)).toBe(msgs)
  })

  it('scope без instructions → без изменений', () => {
    requestScope.run({}, () => {
      const msgs = base()
      expect(withPartnerPolicy(msgs)).toBe(msgs)
      expect(currentPartnerInstructions()).toBeUndefined()
    })
  })

  it('scope с instructions → префиксует system-directive абсолютного приоритета', () => {
    requestScope.run({ instructions: 'скорость 5 м/с' }, () => {
      const msgs = base()
      const out = withPartnerPolicy(msgs)
      expect(out.length).toBe(msgs.length + 1)
      expect(out[0]).toBeInstanceOf(SystemMessage)
      const head = String(out[0].content)
      expect(head).toContain('скорость 5 м/с')
      expect(head).toContain('ПРИОРИТЕТ')
      // исходные сообщения сохранены и идут после директивы
      expect(out[1]).toBe(msgs[0])
      expect(out[2]).toBe(msgs[1])
    })
  })

  it('пустая строка instructions → без изменений', () => {
    requestScope.run({ instructions: '' }, () => {
      const msgs = base()
      expect(withPartnerPolicy(msgs)).toBe(msgs)
    })
  })
})
