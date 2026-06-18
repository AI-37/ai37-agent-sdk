import { describe, expect, it } from 'vitest'
import { componentToA2uiOperations } from '../src'
import type { A2uiComponent } from '../src'

const AI37 = 'https://ai-37.github.io/ai37-a2ui-catalog/a2ui/catalogs/ai37-a2ui/v1/catalog.json'

describe('componentToA2uiOperations (уплощение дерева)', () => {
  it('лист без детей → один компонент id:root (back-compat)', () => {
    const comp: A2uiComponent = { component: 'SimpleTable', props: { columns: ['a'], rows: [] } }
    const [createSurface, update] = componentToA2uiOperations(comp, { surfaceId: 's1', catalogId: AI37 })

    expect(createSurface).toEqual({ version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: AI37 } })
    expect(update).toEqual({
      version: 'v0.9',
      updateComponents: {
        surfaceId: 's1',
        components: [{ id: 'root', component: 'SimpleTable', columns: ['a'], rows: [] }],
      },
    })
  })

  it('вложенность Card{child: LatexFormula} → плоский список с id-ссылкой', () => {
    const comp: A2uiComponent = {
      component: 'Card',
      props: {},
      children: { child: { component: 'LatexFormula', props: { latex: 'E=mc^2' } } },
    }
    const ops = componentToA2uiOperations(comp, { surfaceId: 's1', catalogId: AI37 })
    const components = (ops[1] as any).updateComponents.components

    expect(components).toEqual([
      { id: 'root', component: 'Card', child: 'root.child' },
      { id: 'root.child', component: 'LatexFormula', latex: 'E=mc^2' },
    ])
  })

  it('массив children (Column) → string[] id, детерминированные индексы', () => {
    const comp: A2uiComponent = {
      component: 'Column',
      props: { justify: 'start' },
      children: {
        children: [
          { component: 'Text', props: { text: 'a' } },
          { component: 'Text', props: { text: 'b' } },
        ],
      },
    }
    const components = (componentToA2uiOperations(comp, { surfaceId: 's1' })[1] as any)
      .updateComponents.components

    expect(components).toEqual([
      { id: 'root', component: 'Column', justify: 'start', children: ['root.children.0', 'root.children.1'] },
      { id: 'root.children.0', component: 'Text', text: 'a' },
      { id: 'root.children.1', component: 'Text', text: 'b' },
    ])
  })

  it('catalogId: явный opts → тег компонента → дефолт', () => {
    const tagged: A2uiComponent = { component: 'Card', props: {}, catalogId: AI37 }
    const [cs] = componentToA2uiOperations(tagged, { surfaceId: 's1' })
    expect((cs as any).createSurface.catalogId).toBe(AI37)
  })
})
