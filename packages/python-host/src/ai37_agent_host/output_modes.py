"""Content-negotiation вывода (host-only) — порт ``ts-host/src/output-modes.ts``.

Две независимые оси:
  1. Формат текста — A2A ``acceptedOutputModes`` (media-типы). Аналог HTTP ``Accept``.
  2. Каталог(и) UI — A2UI-нативно: ``a2uiClientCapabilities.v0.9.supportedCatalogIds``.

MIME-вокабуляр (``OUTPUT_MODE_*``) — agent-facing, живёт в ``ai37-agent-sdk``.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from ai37_agent_sdk import OUTPUT_MODE_TEXT, TEXT_OUTPUT_MODES, is_text_output_mode

from .types import A2uiComponent, OutputNegotiation

#: Версия A2UI-протокола в конверте capabilities.
A2UI_CAPABILITIES_VERSION = "v0.9"


# ── Ось 1: формат текста (media-типы) ────────────────────────────────────────


def negotiate_text(
    accepted: Sequence[str] | None,
    agent_supported: Sequence[str],
) -> str:
    """Первый текстовый mode из client∩agent по порядку клиента, иначе OUTPUT_MODE_TEXT."""
    supported = set(agent_supported)
    for mode in accepted or []:
        if is_text_output_mode(mode) and mode in supported:
            return mode
    return OUTPUT_MODE_TEXT


# ── Ось 2: каталог(и) UI (A2UI supportedCatalogIds) ──────────────────────────


def read_client_capabilities(source: Any) -> list[str]:
    """Упорядоченный supportedCatalogIds из носителя (A2A metadata / AG-UI forwardedProps)."""
    caps = source.get("a2uiClientCapabilities") if isinstance(source, dict) else None
    version = caps.get(A2UI_CAPABILITIES_VERSION) if isinstance(caps, dict) else None
    ids = version.get("supportedCatalogIds") if isinstance(version, dict) else None
    if isinstance(ids, list):
        return [s for s in ids if isinstance(s, str)]
    return []


def client_supports_catalog(
    supported_catalog_ids: Sequence[str] | None,
    agent_catalog_id: str | None,
) -> bool:
    return bool(agent_catalog_id) and isinstance(supported_catalog_ids, list | tuple) and (
        agent_catalog_id in supported_catalog_ids
    )


def negotiate_catalogs(
    supported_catalog_ids: Sequence[str] | None,
    agent_catalog_ids: str | Sequence[str] | None,
) -> list[str]:
    """Пересечение (client ∩ agent) в порядке предпочтения клиента. Пусто → UI не слать."""
    if isinstance(agent_catalog_ids, str):
        agent_set = {agent_catalog_ids}
    elif isinstance(agent_catalog_ids, list | tuple):
        agent_set = set(agent_catalog_ids)
    else:
        agent_set = set()
    if not agent_set:
        return []
    client_list = supported_catalog_ids if isinstance(supported_catalog_ids, list | tuple) else []
    return [cid for cid in client_list if cid in agent_set]


def negotiate_catalog(
    supported_catalog_ids: Sequence[str] | None,
    agent_catalog_ids: str | Sequence[str] | None,
) -> str | None:
    """Скалярный выбор каталога: первый из согласованного множества, либо None."""
    catalogs = negotiate_catalogs(supported_catalog_ids, agent_catalog_ids)
    return catalogs[0] if catalogs else None


# ── Сводная негоциация ───────────────────────────────────────────────────────


def negotiate_output(
    *,
    accepted_output_modes: Sequence[str] | None = None,
    agent_text_modes: Sequence[str] | None = None,
    supported_catalog_ids: Sequence[str] | None = None,
    agent_catalog_ids: str | Sequence[str] | None = None,
) -> OutputNegotiation:
    catalog_ids = negotiate_catalogs(supported_catalog_ids, agent_catalog_ids)
    return OutputNegotiation(
        text=negotiate_text(
            accepted_output_modes,
            agent_text_modes if agent_text_modes is not None else TEXT_OUTPUT_MODES,
        ),
        catalog_ids=catalog_ids,
        catalog_id=catalog_ids[0] if catalog_ids else None,
    )


def filter_a2ui_components(
    components: Sequence[A2uiComponent] | None,
    negotiation: OutputNegotiation,
) -> list[A2uiComponent]:
    """Бинарный enforcement: каталог согласован → компоненты как есть; иначе → []."""
    if not negotiation.catalog_ids:
        return []
    return list(components) if components else []


def filter_a2ui_by_catalog(
    components: Sequence[A2uiComponent] | None,
    negotiation: OutputNegotiation,
) -> list[A2uiComponent]:
    """Per-component enforcement: оставляет компоненты, чей каталог в согласованном множестве.

    Компонент без ``catalog_id`` относится к первичному каталогу (``catalog_ids[0]``).
    """
    if not components or not negotiation.catalog_ids:
        return []
    allowed = set(negotiation.catalog_ids)
    primary = negotiation.catalog_ids[0]
    return [c for c in components if (c.catalog_id or primary) in allowed]
