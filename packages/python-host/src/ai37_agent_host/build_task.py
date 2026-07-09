"""Сборка A2A-артефактов из ``AgentResult`` — порт ``ts-host/src/build-task.ts``.

В отличие от TS (где строится Task-dict и публикуется в bus), ``a2a-sdk`` 1.x финализирует
таск через ``TaskUpdater`` (см. ``a2a_executor``). Здесь — только чистые хелперы: сборка
protobuf-``Part`` и content-negotiation результата (РЕШЕНИЕ 10, две оси).
"""

from __future__ import annotations

from typing import Any

from a2a.types import Part
from google.protobuf.json_format import ParseDict

from .output_modes import filter_a2ui_by_catalog
from .types import A2uiComponent, AgentResult, OutputNegotiation


def text_part(text: str) -> Part:
    """protobuf text-``Part`` (``ParseDict`` принимает camelCase → ``media_type``)."""
    return ParseDict({"text": text, "mediaType": "text/plain"}, Part())


def data_part(data: dict[str, Any]) -> Part:
    """protobuf data-``Part`` (JSON Struct)."""
    return ParseDict({"data": data, "mediaType": "application/json"}, Part())


def component_to_dict(component: A2uiComponent) -> dict[str, Any]:
    """Сырое дерево-компонент → JSON-dict (``{component, props, id?, catalogId?, children?}``).

    Уплощение в v0.9-операции делает потребитель (``component_to_a2ui_operations``) — здесь
    сохраняем СЫРОЕ дерево, как TS ``toTask`` (так оркестратор может пробросить его выше).
    """
    out: dict[str, Any] = {"component": component.component, "props": component.props}
    if component.id is not None:
        out["id"] = component.id
    if component.catalog_id is not None:
        out["catalogId"] = component.catalog_id
    if component.children:
        out["children"] = {
            slot: (
                [component_to_dict(x) for x in child]
                if isinstance(child, list)
                else component_to_dict(child)
            )
            for slot, child in component.children.items()
        }
    return out


def resolve_result_a2ui(
    result: AgentResult,
    negotiation: OutputNegotiation,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(a2ui, followup) как СЫРЫЕ дерево-dict'ы после content-negotiation.

    A2UI (включая HITL ``followup``) — только если каталог согласован; иначе пусто.
    """
    a2ui = [component_to_dict(c) for c in filter_a2ui_by_catalog(result.a2ui, negotiation)]
    followup: list[dict[str, Any]] = []
    if result.followup is not None and negotiation.catalog_ids:
        catalog = result.followup.catalog_id or negotiation.catalog_id or ""
        if catalog in negotiation.catalog_ids:
            followup = [component_to_dict(result.followup)]
    return a2ui, followup
