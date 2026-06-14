import { CATALOG_ID } from '@ai37/a2ui-catalog-schemas'
import type { A2uiComponent } from './types'

/** Операция A2UI-поверхности (протокол v0.9: createSurface/updateComponents/updateDataModel/...). */
export type A2uiMessage = Record<string, unknown>

/**
 * Конвертирует декларативный компонент каталога (`{ component, props }`) в v0.9-операции
 * A2UI-поверхности: `createSurface` (с `catalogId` каталога ai37) + `updateComponents`
 * с компонентом-корнем (`id: "root"`, props разворачиваются на уровень компонента).
 *
 * Результат кладётся в `content.a2ui_operations` activity-сообщения `a2ui-surface`,
 * которое нативно рендерит CopilotKit v2 (`createA2UIMessageRenderer` + ai37Catalog).
 */
export function componentToA2uiOperations(
  component: A2uiComponent,
  opts: { surfaceId: string; catalogId?: string },
): A2uiMessage[] {
  const catalogId = opts.catalogId ?? CATALOG_ID
  return [
    { version: 'v0.9', createSurface: { surfaceId: opts.surfaceId, catalogId } },
    {
      version: 'v0.9',
      updateComponents: {
        surfaceId: opts.surfaceId,
        components: [{ id: 'root', component: component.component, ...component.props }],
      },
    },
  ]
}
