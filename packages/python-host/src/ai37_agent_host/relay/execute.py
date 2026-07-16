"""Вызов удалённого A2A-агента (relay) — порт ``ts-host/src/relay/execute.ts``.

Транспорт-агностично: НЕ знает про LangChain/deepagents; стор-операции делает потребитель по
возвращённым ``task_id``/``state``. Форвардит вниз HITL-канал (``metadata.a2uiAction``), негоциацию,
context_files/refs и W3C trace-context (:func:`inject_trace_context`); наверх — текст + A2UI.

Отличие от JS: в ``a2a-sdk`` (Python) ``Client.send_message`` ВСЕГДА возвращает
``AsyncIterator[StreamResponse]`` (oneof ``payload``: task/message/status_update/artifact_update).
Поэтому блокирующий и стрим-вариант схлопнуты в один :func:`execute_remote_a2a` — разница лишь в
наличии ``on_event`` (форвард прогресса). Финальный ``Message | Task`` копим как dict.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from google.protobuf.json_format import MessageToDict, ParseDict

from ..observability.langfuse import inject_trace_context
from ..types import A2uiAction, ContextFile
from .extract import extract_a2ui, extract_text, is_stale_task_error

RemoteA2aState = str  # 'completed' | 'input-required' | 'failed' | 'message'

_STATE_MAP = {
    "TASK_STATE_COMPLETED": "completed",
    "TASK_STATE_INPUT_REQUIRED": "input-required",
    "TASK_STATE_FAILED": "failed",
}


@dataclass
class RemoteA2aRequest:
    query: str
    context_id: str | None = None
    #: Resume: childTaskId, если на прошлом ходу суб-агент был ``input-required`` (HITL/wizard).
    resume_task_id: str | None = None
    #: HITL вниз: клик/submit формы → ``metadata.a2uiAction.userAction``.
    action: A2uiAction | None = None
    #: Негоциация: формат текста → ``configuration.acceptedOutputModes``.
    accepted_output_modes: list[str] | None = None
    #: Негоциация: каталоги A2UI → ``metadata.a2uiClientCapabilities.v0.9``.
    supported_catalog_ids: list[str] | None = None
    #: Вложения/контекст → ``metadata.ai37.context_refs``.
    context_refs: list[str] | None = None
    #: Манифест приложенных файлов → ``metadata.ai37.context_files``.
    context_files: list[ContextFile] | None = None
    #: Доп. поля в ``message.metadata`` (напр. relay hop-guard) — escape hatch.
    extra_metadata: dict[str, Any] | None = None


@dataclass
class RemoteA2aResult:
    text: str
    a2ui: list[dict[str, Any]] = field(default_factory=list)
    #: childTaskId (если ответ — Task); потребитель персистит для resume.
    task_id: str | None = None
    state: RemoteA2aState = "message"
    #: true, если ``resume_task_id`` оказался устаревшим и запрос повторён как свежий диалог.
    stale_resume_dropped: bool = False
    #: Финальный нормализованный Message|Task (dict).
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class RemoteA2aToolCall:
    """Структурный тул-колл сабагента (для ``type:'tool'``)."""

    id: str
    #: Человекочитаемое имя/лейбл для карточки.
    name: str
    tool_name: str | None = None
    args: Any = None
    result: Any = None
    status: str | None = None
    error: str | None = None


@dataclass
class RemoteA2aProgressEvent:
    """Промежуточное событие прогресса/COT удалённого агента (из A2A-потока).

    ``node``/``reasoning`` — из ``status-update.metadata`` (``ai37/node``/``ai37/reasoning``, COT);
    ``text`` — дельта ФИНАЛЬНОГО текста из канонических ``artifact-update``(append) text-частей →
    AG-UI ``TEXT_MESSAGE_CONTENT``; ``tool`` — тул-колл сабагента из ``metadata['ai37/tool']`` →
    AG-UI ``TOOL_CALL_*`` (у A2A нет нативного тул-события; та же progress-конвенция, что node).
    """

    type: str  # 'node' | 'reasoning' | 'text' | 'tool'
    #: Имя ноды/reasoning-дельта/дельта текста. Для ``tool`` — ''.
    value: str
    #: Структура тул-колла — только для ``type:'tool'``.
    tool: RemoteA2aToolCall | None = None


def _tool_call(d: dict[str, Any]) -> RemoteA2aToolCall:
    return RemoteA2aToolCall(
        id=str(d.get("id", "")),
        name=str(d.get("name", "")),
        tool_name=d.get("toolName"),
        args=d.get("args"),
        result=d.get("result"),
        status=d.get("status"),
        error=d.get("error"),
    )


OnEvent = Callable[[RemoteA2aProgressEvent], None]


def _context_file_dict(f: ContextFile) -> dict[str, Any]:
    out: dict[str, Any] = {"ref": f.ref, "name": f.name, "scope": f.scope}
    if f.summary is not None:
        out["summary"] = f.summary
    if f.is_large is not None:
        out["isLarge"] = f.is_large
    return out


def _action_dict(a: A2uiAction) -> dict[str, Any]:
    out: dict[str, Any] = {"name": a.name, "context": a.context}
    if a.surface_id is not None:
        out["surfaceId"] = a.surface_id
    if a.source_component_id is not None:
        out["sourceComponentId"] = a.source_component_id
    return out


def _build_request(req: RemoteA2aRequest, with_resume: bool) -> Any:
    """Собрать protobuf ``SendMessageRequest`` (ParseDict принимает camelCase)."""
    from a2a.types.a2a_pb2 import SendMessageRequest

    metadata: dict[str, Any] = {}
    if req.supported_catalog_ids:
        metadata["a2uiClientCapabilities"] = {
            "v0.9": {"supportedCatalogIds": req.supported_catalog_ids}
        }
    # ai37-конверт собираем единым объектом (context_refs + context_files едут вместе).
    ai37: dict[str, Any] = {}
    if req.context_refs:
        ai37["context_refs"] = req.context_refs
    if req.context_files:
        ai37["context_files"] = [_context_file_dict(f) for f in req.context_files]
    if ai37:
        metadata["ai37"] = ai37
    if req.action:
        metadata["a2uiAction"] = {"userAction": _action_dict(req.action)}
    if req.extra_metadata:
        metadata.update(req.extra_metadata)
    # W3C trace-context активного turn/remote-a2a спана вниз ({} если трассировка off).
    metadata.update(inject_trace_context())

    message: dict[str, Any] = {
        "messageId": str(uuid.uuid4()),
        "role": "ROLE_USER",
        "parts": [{"text": req.query, "mediaType": "text/plain"}],
    }
    if req.context_id:
        message["contextId"] = req.context_id
    if with_resume and req.resume_task_id:
        message["taskId"] = req.resume_task_id
    if metadata:
        message["metadata"] = metadata

    payload: dict[str, Any] = {"message": message}
    if req.accepted_output_modes:
        payload["configuration"] = {"acceptedOutputModes": req.accepted_output_modes}
    return ParseDict(payload, SendMessageRequest())


def _is_task_dict(d: dict[str, Any]) -> bool:
    return "status" in d or "artifacts" in d


def _to_state(raw: dict[str, Any]) -> RemoteA2aState:
    if not _is_task_dict(raw):
        return "message"
    status = raw.get("status")
    state = status.get("state") if isinstance(status, dict) else None
    return _STATE_MAP.get(state, "message")


def _apply_artifact(task: dict[str, Any], au: dict[str, Any]) -> None:
    artifact = au.get("artifact")
    if not isinstance(artifact, dict):
        return
    artifacts = task.setdefault("artifacts", [])
    idx = next(
        (i for i, a in enumerate(artifacts) if a.get("artifactId") == artifact.get("artifactId")),
        -1,
    )
    if idx >= 0 and au.get("append"):
        merged = dict(artifacts[idx])
        merged["parts"] = (artifacts[idx].get("parts") or []) + (artifact.get("parts") or [])
        artifacts[idx] = merged
    elif idx >= 0:
        artifacts[idx] = artifact
    else:
        artifacts.append(artifact)


async def _drain(stream: Any, on_event: OnEvent | None) -> dict[str, Any] | None:
    """Накопить финальный Message|Task (dict) из ``StreamResponse``, форвардя node/reasoning."""
    task: dict[str, Any] | None = None
    message: dict[str, Any] | None = None
    async for sr in stream:
        which = sr.WhichOneof("payload")
        if which == "message":
            message = MessageToDict(sr.message, preserving_proto_field_name=False)
        elif which == "task":
            task = MessageToDict(sr.task, preserving_proto_field_name=False)
        elif which == "status_update":
            su = MessageToDict(sr.status_update, preserving_proto_field_name=False)
            meta = su.get("metadata") or {}
            if on_event is not None:
                node = meta.get("ai37/node")
                reasoning = meta.get("ai37/reasoning")
                tool = meta.get("ai37/tool")
                if isinstance(node, str):
                    on_event(RemoteA2aProgressEvent("node", node))
                if isinstance(reasoning, str):
                    on_event(RemoteA2aProgressEvent("reasoning", reasoning))
                # ai37/tool → тул-колл сабагента (у A2A нет нативного тул-события).
                if isinstance(tool, dict):
                    on_event(RemoteA2aProgressEvent("tool", "", _tool_call(tool)))
            if task is not None and su.get("taskId") == task.get("id") and su.get("status"):
                task["status"] = su["status"]
        elif which == "artifact_update":
            au = MessageToDict(sr.artifact_update, preserving_proto_field_name=False)
            # Канон A2A: append=true → ИНКРЕМЕНТ (дельта), иначе снапшот (replace). Стрим текста
            # поднимаем ТОЛЬКО при append (part.text = дельта); снапшот как дельту слать нельзя —
            # потребитель конкатенирует и получит дубли. Финальный текст всё равно соберётся в task
            # (extract_text); data-части (a2ui) не трогаем — уедут через extract_a2ui.
            if on_event is not None and au.get("append"):
                artifact = au.get("artifact")
                if isinstance(artifact, dict):
                    for part in artifact.get("parts") or []:
                        text = part.get("text") if isinstance(part, dict) else None
                        if isinstance(text, str) and text:
                            on_event(RemoteA2aProgressEvent("text", text))
            if task is not None and au.get("taskId") == task.get("id"):
                _apply_artifact(task, au)
    # Финальный результат: message главнее накопленного task (как ResultManager.getFinalResult).
    return message or task


async def execute_remote_a2a(
    client: Any, req: RemoteA2aRequest, on_event: OnEvent | None = None
) -> RemoteA2aResult:
    """Вызвать удалённого A2A-агента; при устаревшем resume — повтор как свежий диалог."""
    stale = False
    try:
        raw = await _drain(client.send_message(_build_request(req, True)), on_event)
    except Exception as exc:  # noqa: BLE001 - решаем по типу ошибки ниже
        if req.resume_task_id and is_stale_task_error(exc):
            stale = True
            raw = await _drain(client.send_message(_build_request(req, False)), on_event)
        else:
            raise
    if raw is None:
        raise RuntimeError("execute_remote_a2a: поток не дал финального Message/Task")
    return RemoteA2aResult(
        text=extract_text(raw),
        a2ui=extract_a2ui(raw),
        task_id=raw.get("id") if _is_task_dict(raw) else None,
        state=_to_state(raw),
        stale_resume_dropped=stale,
        raw=raw,
    )
