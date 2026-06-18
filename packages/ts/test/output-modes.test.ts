import { describe, expect, it } from 'vitest'
import {
  OUTPUT_MODE_TEXT,
  OUTPUT_MODE_MARKDOWN,
  OUTPUT_MODE_MARKDOWN_SPAI,
  negotiateText,
  negotiateCatalog,
  negotiateOutput,
  readClientCapabilities,
  clientSupportsCatalog,
  filterA2uiComponents,
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

describe('negotiateCatalog (ось каталога A2UI)', () => {
  it('каталог агента есть в списке клиента → этот каталог', () => {
    expect(negotiateCatalog([AI37], AI37)).toBe(AI37)
  })
  it('клиент поддерживает только base, агент эмитит ai37 → null (UI не слать)', () => {
    expect(negotiateCatalog([BASE], AI37)).toBeNull()
  })
  it('клиент не прислал каталогов → null', () => {
    expect(negotiateCatalog(undefined, AI37)).toBeNull()
    expect(negotiateCatalog([], AI37)).toBeNull()
  })
  it('агент без каталога (текстовый) → null даже если клиент что-то прислал', () => {
    expect(negotiateCatalog([AI37], undefined)).toBeNull()
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
  it('каталог поддержан → text + catalogId', () => {
    const n = negotiateOutput({
      acceptedOutputModes: [OUTPUT_MODE_MARKDOWN],
      agentTextModes: AGENT_TEXT,
      supportedCatalogIds: [AI37],
      agentCatalogIds: AI37,
    })
    expect(n).toEqual({ text: OUTPUT_MODE_MARKDOWN, catalogId: AI37 })
  })
  it('каталог не поддержан → catalogId null, текст остаётся', () => {
    const n = negotiateOutput({ supportedCatalogIds: [BASE], agentCatalogIds: AI37 })
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
    expect(filterA2uiComponents(comps, { text: OUTPUT_MODE_TEXT, catalogId: null })).toEqual([])
    expect(filterA2uiComponents(comps, { text: OUTPUT_MODE_TEXT, catalogId: AI37 })).toEqual(comps)
  })
})
