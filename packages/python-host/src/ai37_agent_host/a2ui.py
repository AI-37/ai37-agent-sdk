"""Уплощение дерева A2UI в v0.9-операции поверхности — порт ``ts-host/src/a2ui.ts``.

Протокол v0.9 не допускает inline-вложенность: дерево уплощается в плоский список
компонентов, дети — по детерминированным id-ссылкам (важно для апсерта по id при стриминге).
"""

from __future__ import annotations

from typing import Any

from .types import A2uiComponent

# ``CATALOG_ID`` (дефолтный ai37-каталог) живёт в python-пакете каталога, который может быть
# не установлен (другой репозиторий, не в индексе). Импорт мягкий: на практике create_agent_host
# всегда передаёт catalog_id явно из agent-card, дефолт нужен редко.
try:  # pragma: no cover - зависит от наличия пакета каталога
    from ai37_a2ui_catalog import CATALOG_ID as DEFAULT_CATALOG_ID
except Exception:  # pragma: no cover
    DEFAULT_CATALOG_ID = None

#: Операция A2UI-поверхности (v0.9: createSurface / updateComponents / ...).
A2uiMessage = dict[str, Any]


def _flatten(node: A2uiComponent, node_id: str, out: list[dict[str, Any]]) -> None:
    # Узел добавляется первым; слот-props (id-ссылки) дописываются после раскрытия детей.
    entry: dict[str, Any] = {"id": node_id, "component": node.component, **node.props}
    out.append(entry)

    if not node.children:
        return
    for slot, child in node.children.items():
        if isinstance(child, list):
            ids: list[str] = []
            for i, c in enumerate(child):
                child_id = c.id or f"{node_id}.{slot}.{i}"
                _flatten(c, child_id, out)
                ids.append(child_id)
            entry[slot] = ids
        else:
            child_id = child.id or f"{node_id}.{slot}"
            _flatten(child, child_id, out)
            entry[slot] = child_id


def component_to_a2ui_operations(
    component: A2uiComponent,
    *,
    surface_id: str,
    catalog_id: str | None = None,
) -> list[A2uiMessage]:
    """Дерево-компонент → ``createSurface`` (+catalogId) + ``updateComponents`` (уплощённое дерево).

    ``catalog_id``: явный аргумент → тег компонента → дефолтный ``CATALOG_ID``.
    Корень surface всегда ``'root'`` (v0.9); ``component.id`` верхнего узла игнорируется.
    """
    resolved = catalog_id or component.catalog_id or DEFAULT_CATALOG_ID
    components: list[dict[str, Any]] = []
    _flatten(component, "root", components)
    return [
        {
            "version": "v0.9",
            "createSurface": {"surfaceId": surface_id, "catalogId": resolved},
        },
        {
            "version": "v0.9",
            "updateComponents": {"surfaceId": surface_id, "components": components},
        },
    ]
