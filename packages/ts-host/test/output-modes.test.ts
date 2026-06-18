import { describe, expect, it } from 'vitest'
import { OUTPUT_MODE_TEXT, OUTPUT_MODE_MARKDOWN, OUTPUT_MODE_MARKDOWN_SPAI } from '@ai37/agent-sdk'
import {
  negotiateText,
  negotiateCatalog,
  negotiateCatalogs,
  negotiateOutput,
  readClientCapabilities,
  clientSupportsCatalog,
  filterA2uiComponents,
  filterA2uiByCatalog,
} from '../src'

const AI37 = 'https://ai-37.github.io/ai37-a2ui-catalog/a2ui/catalogs/ai37-a2ui/v1/catalog.json'
const BASE = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json'
const AGENT_TEXT = [OUTPUT_MODE_MARKDOWN, OUTPUT_MODE_TEXT]

describe('negotiateText (ось формата текста)', () => {
  it('пусто → text/plain', () => {
    expect(negotiateText(undefined, AGENT_TEXT)).toBe(OUTPUT_MODE_TEXT)
    expect(negotiateText([], AGENT_TEXT)).toBe(OUTPUT_MODE_TEXT)
  })
  it('первый текстовый из пересечения по порядку клиента', () => {
    expect(negotiateText([OUTPUT_MODE_MARKDOWN, OUTPUT_MODE_TEXT], AGENT_TEXT)).toBe(OUTPUT_MODE_MARKDOWN)
  })
  it('клиент просит формат, который агент не умеет → fallback text/plain', () => {
    expect(negotiateText([OUTPUT_MODE_MARKDOWN_SPAI], [OUTPUT_MODE_TEXT])).toBe(OUTPUT_MODE_TEXT)
  })
})

describe('negotiateCatalogs (множество каталогов A2UI)', () => {
  it('пересечение в порядке предпочтения клиента', () => {
    expect(negotiateCatalogs([AI37, BASE], [BASE, AI37])).toEqual([AI37, BASE])
    expect(negotiateCatalogs([BASE, AI37], [AI37, BASE])).toEqual([BASE, AI37])
  })
  it('клиент умеет только base, агент эмитит оба → [base]', () => {
    expect(negotiateCatalogs([BASE], [AI37, BASE])).toEqual([BASE])
  })
  it('нет пересечения → []', () => {
    expect(negotiateCatalogs([BASE], AI37)).toEqual([])
    expect(negotiateCatalogs(undefined, AI37)).toEqual([])
    expect(negotiateCatalogs([], AI37)).toEqual([])
  })
  it('агент без каталога → []', () => {
    expect(negotiateCatalogs([AI37], undefined)).toEqual([])
  })
})

describe('negotiateCatalog (скалярный alias)', () => {
  it('каталог агента есть в списке клиента → этот каталог', () => {
    expect(negotiateCatalog([AI37], AI37)).toBe(AI37)
  })
  it('клиент поддерживает только base, агент эмитит ai37 → null', () => {
    expect(negotiateCatalog([BASE], AI37)).toBeNull()
  })
  it('несколько каталогов агента → первый по порядку клиента', () => {
    expect(negotiateCatalog([BASE, AI37], [AI37, BASE])).toBe(BASE)
  })
})

describe('readClientCapabilities', () => {
  it('достаёт supportedCatalogIds из a2uiClientCapabilities.v0.9', () => {
    const src = { a2uiClientCapabilities: { 'v0.9': { supportedCatalogIds: [AI37, BASE] } } }
    expect(readClientCapabilities(src)).toEqual([AI37, BASE])
  })
  it('нет конверта → []', () => {
    expect(readClientCapabilities({})).toEqual([])
    expect(readClientCapabilities(undefined)).toEqual([])
  })
})

describe('negotiateOutput (две оси сразу) + хелперы', () => {
  it('каталог поддержан → text + catalogIds + catalogId', () => {
    const n = negotiateOutput({
      acceptedOutputModes: [OUTPUT_MODE_MARKDOWN],
      agentTextModes: AGENT_TEXT,
      supportedCatalogIds: [AI37, BASE],
      agentCatalogIds: [AI37, BASE],
    })
    expect(n).toEqual({ text: OUTPUT_MODE_MARKDOWN, catalogIds: [AI37, BASE], catalogId: AI37 })
  })
  it('каталог не поддержан → пусто, текст остаётся', () => {
    const n = negotiateOutput({ supportedCatalogIds: [BASE], agentCatalogIds: AI37 })
    expect(n.catalogIds).toEqual([])
    expect(n.catalogId).toBeNull()
    expect(n.text).toBe(OUTPUT_MODE_TEXT)
  })
  it('clientSupportsCatalog', () => {
    expect(clientSupportsCatalog([AI37], AI37)).toBe(true)
    expect(clientSupportsCatalog([BASE], AI37)).toBe(false)
    expect(clientSupportsCatalog(undefined, AI37)).toBe(false)
  })
  it('filterA2uiComponents отсекает компоненты без согласованного каталога', () => {
    const comps = [{ component: 'SimpleTable', props: {} }]
    expect(filterA2uiComponents(comps, { text: OUTPUT_MODE_TEXT, catalogIds: [], catalogId: null })).toEqual([])
    expect(filterA2uiComponents(comps, { text: OUTPUT_MODE_TEXT, catalogIds: [AI37], catalogId: AI37 })).toEqual(comps)
  })
  it('filterA2uiByCatalog: оставляет только компоненты из согласованного множества', () => {
    type Comp = { component: string; props: object; catalogId?: string }
    const ai37Comp: Comp = { component: 'SimpleTable', props: {}, catalogId: AI37 }
    const baseComp: Comp = { component: 'Card', props: {}, catalogId: BASE }
    const untagged: Comp = { component: 'SimpleTable', props: {} } // → первичный каталог
    const n = { text: OUTPUT_MODE_TEXT, catalogIds: [AI37], catalogId: AI37 }
    expect(filterA2uiByCatalog([ai37Comp, baseComp, untagged], n)).toEqual([ai37Comp, untagged])
  })
  it('filterA2uiByCatalog: оба каталога согласованы → пропускает оба', () => {
    const ai37Comp = { component: 'SimpleTable', props: {}, catalogId: AI37 }
    const baseComp = { component: 'Card', props: {}, catalogId: BASE }
    const n = { text: OUTPUT_MODE_TEXT, catalogIds: [AI37, BASE], catalogId: AI37 }
    expect(filterA2uiByCatalog([ai37Comp, baseComp], n)).toEqual([ai37Comp, baseComp])
  })
})
