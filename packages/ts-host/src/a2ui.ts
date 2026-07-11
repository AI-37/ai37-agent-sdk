import { CATALOG_ID } from '@ai37/a2ui-catalog-schemas'
import type { A2uiComponent, A2uiDataPatch } from './types'

/** Операция A2UI-поверхности (протокол v0.9: createSurface/updateComponents/updateDataModel/...). */
export type A2uiMessage = Record<string, unknown>

/** Плоская запись компонента в `updateComponents.components` (id + имя + props + слот-ссылки). */
type FlatComponent = Record<string, unknown> & { id: string; component: string }

/**
 * Уплощает дерево `A2uiComponent` в плоский список компонентов протокола v0.9: каждому узлу — `id`
 * (корень → `'root'`, детям — ДЕТЕРМИНИРОВАННЫЕ `${parentId}.${slot}[.${i}]`, важно для апсерта по id
 * при стриминге), в prop-слот родителя кладётся id-ссылка (строка для `ComponentIdSchema`, `string[]`
 * для `ChildListSchema`). Inline-вложенность протоколом запрещена.
 */
function flatten(node: A2uiComponent, id: string, out: FlatComponent[]): void {
  // Корень/узел добавляется первым; слот-props дописываются после раскрытия детей (id-ссылки).
  const entry: FlatComponent = { id, component: node.component, ...node.props }
  out.push(entry)

  if (!node.children) return
  for (const [slot, child] of Object.entries(node.children)) {
    if (Array.isArray(child)) {
      entry[slot] = child.map((c, i) => {
        const childId = c.id ?? `${id}.${slot}.${i}`
        flatten(c, childId, out)
        return childId
      })
    } else {
      const childId = child.id ?? `${id}.${slot}`
      flatten(child, childId, out)
      entry[slot] = childId
    }
  }
}

/**
 * Конвертирует декларативный компонент-дерево каталога в v0.9-операции A2UI-поверхности:
 * `createSurface` (с `catalogId`) + `updateComponents` с уплощённым деревом (корень `id: "root"`).
 * `catalogId`: явный `opts.catalogId` → тег компонента → дефолтный ai37 `CATALOG_ID`.
 *
 * Результат кладётся в `content.a2ui_operations` activity-сообщения `a2ui-surface`,
 * которое нативно рендерит CopilotKit v2 (`createA2UIMessageRenderer` + ai37Catalog).
 */
export function componentToA2uiOperations(
  component: A2uiComponent,
  opts: { surfaceId: string; catalogId?: string; dataModel?: A2uiDataPatch[] },
): A2uiMessage[] {
  const catalogId = opts.catalogId ?? component.catalogId ?? CATALOG_ID
  const components: FlatComponent[] = []
  // Корень surface всегда `'root'` (протокол v0.9); `component.id` верхнего узла игнорируется.
  flatten(component, 'root', components)
  return [
    { version: 'v0.9', createSurface: { surfaceId: opts.surfaceId, catalogId } },
    {
      version: 'v0.9',
      updateComponents: { surfaceId: opts.surfaceId, components },
    },
    // Патчи dataModel (напр. опции lookup-канала FormCard) — после компонентов,
    // чтобы подписчики читали значение с уже живого surface. `path` — точная
    // строка (ведущий слэш значим для клиента).
    ...(opts.dataModel ?? []).map((patch) => ({
      version: 'v0.9',
      updateDataModel: { surfaceId: opts.surfaceId, path: patch.path, value: patch.value },
    })),
  ]
}
