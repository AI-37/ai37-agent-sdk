"""Нормализация входящего A2A-сообщения — порт ``ts-host/src/parse.ts``.

``a2a-sdk`` 1.x — protobuf-мир: ``rc.message`` — это ``a2a_pb2.Message``. Читаем его через
``MessageToDict`` (как Minstroy ``_extract_payload``), затем достаём text/data-парты, конверт
``metadata.ai37``, A2UI-действие и W3C trace-carrier.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from google.protobuf.json_format import MessageToDict

from .output_modes import read_client_capabilities
from .types import A2uiAction, Ai37Metadata, ContextFile, IntentEnvelope


@dataclass
class ParsedMessage:
    data: dict[str, Any]
    metadata: Ai37Metadata
    text: str | None = None
    #: A2UI-действие (клик/submit) из message.metadata.a2uiAction (форвард оркестратора).
    action: A2uiAction | None = None
    #: W3C trace-context (traceparent/tracestate) из message.metadata (injectTraceContext).
    trace_carrier: dict[str, str] | None = None
    #: supportedCatalogIds клиента (a2uiClientCapabilities.v0.9) из метаданных сообщения.
    supported_catalog_ids: list[str] = field(default_factory=list)


def parse_a2a_message(rc: Any) -> ParsedMessage:
    """Нормализует A2A-сообщение: текст + data-part + конверт metadata.ai37 + A2UI-действие."""
    message = getattr(rc, "message", None)
    msg = MessageToDict(message, preserving_proto_field_name=False) if message is not None else {}
    parts = msg.get("parts") or []
    text: str | None = None
    data: dict[str, Any] = {}
    for part in parts:
        if not isinstance(part, dict):
            continue
        if text is None and isinstance(part.get("text"), str):
            text = part["text"]
        elif not data and isinstance(part.get("data"), dict):
            data = part["data"]
    md = msg.get("metadata") or {}
    return ParsedMessage(
        text=text,
        data=data,
        metadata=_read_ai37_metadata(md, data),
        action=_read_a2ui_action(md),
        trace_carrier=_read_trace_carrier(md),
        supported_catalog_ids=read_client_capabilities(md),
    )


def _read_trace_carrier(md: dict[str, Any]) -> dict[str, str] | None:
    traceparent = md.get("traceparent")
    if not isinstance(traceparent, str) or not traceparent:
        return None
    carrier = {"traceparent": traceparent}
    tracestate = md.get("tracestate")
    if isinstance(tracestate, str):
        carrier["tracestate"] = tracestate
    return carrier


def _read_a2ui_action(md: dict[str, Any]) -> A2uiAction | None:
    envelope = md.get("a2uiAction")
    user_action = envelope.get("userAction") if isinstance(envelope, dict) else None
    if not isinstance(user_action, dict) or not isinstance(user_action.get("name"), str):
        return None
    ctx = user_action.get("context")
    action = A2uiAction(
        name=user_action["name"],
        context=ctx if isinstance(ctx, dict) else {},
    )
    if isinstance(user_action.get("surfaceId"), str):
        action.surface_id = user_action["surfaceId"]
    if isinstance(user_action.get("sourceComponentId"), str):
        action.source_component_id = user_action["sourceComponentId"]
    return action


def _read_ai37_metadata(md: dict[str, Any], data: dict[str, Any]) -> Ai37Metadata:
    """metadata.ai37 может прийти в message.metadata, data.ai37 или data.metadata.ai37."""
    from_msg = md.get("ai37") if isinstance(md.get("ai37"), dict) else None
    nested = None
    if isinstance(data.get("metadata"), dict):
        nested = data["metadata"].get("ai37")
    from_data = data.get("ai37") if isinstance(data.get("ai37"), dict) else nested
    # message.metadata.ai37 перекрывает data.ai37 (как в TS).
    merged: dict[str, Any] = {**(from_data or {}), **(from_msg or {})}
    return _to_ai37_metadata(merged)


def _to_ai37_metadata(raw: dict[str, Any]) -> Ai37Metadata:
    context_files = raw.get("context_files")
    intent = raw.get("intent")
    return Ai37Metadata(
        tenant=raw.get("tenant"),
        app_id=raw.get("app_id"),
        channel=raw.get("channel"),
        thread_id=raw.get("thread_id"),
        session_id=raw.get("session_id"),
        context_refs=raw.get("context_refs"),
        context_files=(
            [_to_context_file(c) for c in context_files if isinstance(c, dict)]
            if isinstance(context_files, list)
            else None
        ),
        intent=(
            IntentEnvelope(skill=intent["skill"], params=intent.get("params"))
            if isinstance(intent, dict) and isinstance(intent.get("skill"), str)
            else None
        ),
        trace_id=raw.get("trace_id"),
        accepted_output_modes=raw.get("acceptedOutputModes"),
    )


def _to_context_file(raw: dict[str, Any]) -> ContextFile:
    return ContextFile(
        ref=raw.get("ref", ""),
        name=raw.get("name", ""),
        scope=raw.get("scope", "chat"),
        summary=raw.get("summary"),
        is_large=raw.get("isLarge"),
    )
