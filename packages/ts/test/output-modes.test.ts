import { describe, expect, it } from 'vitest'
import { CATALOG_ID, A2UI_BASE_CATALOG_ID } from '@ai37/a2ui-catalog-schemas/constants'
import {
  OUTPUT_MODE_TEXT,
  OUTPUT_MODE_MARKDOWN,
  OUTPUT_MODE_MARKDOWN_SPAI,
  OUTPUT_MODE_A2UI_BASE,
  OUTPUT_MODE_A2UI_AI37,
  negotiateOutput,
  clientAcceptsA2ui,
  filterA2uiComponents,
} from '../src'

// что умеет отдавать типичный ai37-агент
const AGENT = [
  OUTPUT_MODE_MARKDOWN_SPAI,
  OUTPUT_MODE_MARKDOWN,
  OUTPUT_MODE_TEXT,
  OUTPUT_MODE_A2UI_AI37,
]

describe('negotiateOutput — дефолт текст', () => {
  it('пусто → текст без A2UI', () => {
    expect(negotiateOutput(undefined, AGENT)).toEqual({ text: OUTPUT_MODE_TEXT, a2ui: false })
    expect(negotiateOutput([], AGENT)).toEqual({ text: OUTPUT_MODE_TEXT, a2ui: false })
  })

  it('только текстовые modes → текст по порядку клиента, A2UI false', () => {
    const n = negotiateOutput([OUTPUT_MODE_MARKDOWN, OUTPUT_MODE_TEXT], AGENT)
    expect(n.text).toBe(OUTPUT_MODE_MARKDOWN)
    expect(n.a2ui).toBe(false)
  })

  it('клиент просит A2UI, но агент не поддерживает → A2UI false', () => {
    const n = negotiateOutput([OUTPUT_MODE_A2UI_AI37], [OUTPUT_MODE_TEXT])
    expect(n.a2ui).toBe(false)
    expect(n.text).toBe(OUTPUT_MODE_TEXT)
  })
})

describe('negotiateOutput — A2UI по явному запросу', () => {
  it('ai37-mime → ai37-каталог', () => {
    const n = negotiateOutput([OUTPUT_MODE_A2UI_AI37, OUTPUT_MODE_MARKDOWN], AGENT)
    expect(n.a2ui).toEqual({ catalogId: CATALOG_ID, mode: OUTPUT_MODE_A2UI_AI37 })
    expect(n.text).toBe(OUTPUT_MODE_MARKDOWN)
  })

  it('клиент принял оба A2UI-mime → ai37 предпочтительнее base', () => {
    const agentBoth = [...AGENT, OUTPUT_MODE_A2UI_BASE]
    const n = negotiateOutput([OUTPUT_MODE_A2UI_BASE, OUTPUT_MODE_A2UI_AI37], agentBoth)
    expect(n.a2ui).toEqual({ catalogId: CATALOG_ID, mode: OUTPUT_MODE_A2UI_AI37 })
  })

  it('клиент base, агент поддерживает только base → base-каталог', () => {
    const n = negotiateOutput([OUTPUT_MODE_A2UI_BASE], [OUTPUT_MODE_TEXT, OUTPUT_MODE_A2UI_BASE])
    expect(n.a2ui).toEqual({ catalogId: A2UI_BASE_CATALOG_ID, mode: OUTPUT_MODE_A2UI_BASE })
  })

  it('клиент base, но агент эмитит только ai37-компоненты (base не поддержан) → текст', () => {
    const n = negotiateOutput([OUTPUT_MODE_A2UI_BASE], AGENT) // AGENT не содержит base
    expect(n.a2ui).toBe(false)
  })
})

describe('хелперы', () => {
  it('clientAcceptsA2ui', () => {
    expect(clientAcceptsA2ui([OUTPUT_MODE_MARKDOWN])).toBe(false)
    expect(clientAcceptsA2ui([OUTPUT_MODE_A2UI_AI37])).toBe(true)
    expect(clientAcceptsA2ui(undefined)).toBe(false)
  })

  it('filterA2uiComponents отсекает компоненты, если A2UI не запрошен', () => {
    const comps = [{ component: 'SimpleTable', props: {} }]
    expect(filterA2uiComponents(comps, { text: OUTPUT_MODE_TEXT, a2ui: false })).toEqual([])
    expect(
      filterA2uiComponents(comps, {
        text: OUTPUT_MODE_TEXT,
        a2ui: { catalogId: CATALOG_ID, mode: OUTPUT_MODE_A2UI_AI37 },
      }),
    ).toEqual(comps)
  })
})
