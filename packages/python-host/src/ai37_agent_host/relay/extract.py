"""Разбор ответа удалённого A2A-агента — порт ``ts-host/src/relay/extract.ts``.

Чистые хелперы над ``Message | Task``: без ALS/LangChain — переносимы в любой relay. В отличие от
JS (дискриминатор ``result.kind``), в protobuf-мире ``a2a-sdk`` типа-тега нет: Task отличаем по
наличию поля ``status``/``artifacts``. На вход — protobuf-объект ИЛИ уже нормализованный dict
(``MessageToDict``) — для тестируемости. A2UI-деревья пробрасываем как СЫРЫЕ dict'ы (оркестратор
поднимет их своим surface'ом).
"""

from __future__ import annotations

from typing import Any

from google.protobuf.json_format import MessageToDict


def _to_dict(result: Any) -> dict[str, Any]:
    if isinstance(result, dict):
        return result
    if hasattr(result, "DESCRIPTOR"):
        return MessageToDict(result, preserving_proto_field_name=False)
    return {}


def _is_task(d: dict[str, Any]) -> bool:
    return "status" in d or "artifacts" in d


def _parts_text(parts: Any) -> str:
    if not isinstance(parts, list):
        return ""
    return "".join(
        p["text"] for p in parts if isinstance(p, dict) and isinstance(p.get("text"), str)
    )


def _collect_task_text(task: dict[str, Any]) -> str:
    """Текст ответа из ``Task``. Авторитет — ``status.message`` терминального снапшота;
    text-артефакты СУММИРОВАТЬ с ним нельзя (порт фикса ts-host ``relay/extract.ts``).

    Почему: A2A штатно разрешает стримить ответ дельтами (``artifact-update`` + ``append``), и
    text-артефакт в этом случае — ЖИВАЯ ПРОЕКЦИЯ того же ответа, а не вторая его часть. Такой
    агент отдаёт один и тот же текст дважды: дельтами в артефакт и снапшотом в ``status.message``.
    Прежняя склейка обоих каналов печатала пользователю ОТВЕТ ДВАЖДЫ. Баг был латентным: у агентов
    на ``create_agent_host`` артефакты несут только data-part (см. ``a2a_executor._finalize``),
    поэтому склейка была безвредна — и ломалась ровно на том, кто пользуется штатным стримингом A2A.

    Почему авторитет именно ``status.message``: прошлые ``artifact-update`` сервер НЕ реплеит
    (журнала событий нет), поэтому после reconnect/``tasks/get`` доживает только снапшот — стрим
    невосстановим.

    Fallback на артефакты — если терминального текста нет вовсе (агент отдал только стрим): тогда
    артефакты и есть единственный источник.
    """
    status = task.get("status")
    if isinstance(status, dict) and isinstance(status.get("message"), dict):
        status_text = _parts_text(status["message"].get("parts"))
        if status_text:
            return status_text

    chunks: list[str] = []
    for artifact in task.get("artifacts") or []:
        if isinstance(artifact, dict):
            chunks.append(_parts_text(artifact.get("parts")))
    return "\n\n".join(c for c in chunks if c)


def extract_text(result: Any) -> str:
    """Текст из результата ``send_message`` (Message | Task)."""
    d = _to_dict(result)
    text = _collect_task_text(d) if _is_task(d) else _parts_text(d.get("parts"))
    return text.strip()


def extract_a2ui(result: Any) -> list[dict[str, Any]]:
    """Сырые A2UI: ``completed`` → ``artifact.parts[data].data.a2ui``; форма → ``metadata.a2ui``."""
    d = _to_dict(result)
    if not _is_task(d):
        return []
    out: list[dict[str, Any]] = []
    for artifact in d.get("artifacts") or []:
        if not isinstance(artifact, dict):
            continue
        for part in artifact.get("parts") or []:
            if isinstance(part, dict) and isinstance(part.get("data"), dict):
                a2ui = part["data"].get("a2ui")
                if isinstance(a2ui, list):
                    out.extend(a2ui)
    meta = d.get("metadata")
    if isinstance(meta, dict) and isinstance(meta.get("a2ui"), list):
        out.extend(meta["a2ui"])
    return out


def is_stale_task_error(err: Any) -> bool:
    """Таск устарел/не найден/терминален → повторить БЕЗ resume (A2A -32001 + текстовые маркеры)."""
    code = err.get("code") if isinstance(err, dict) else getattr(err, "code", None)
    if code == -32001:
        return True
    raw = err.get("message") if isinstance(err, dict) else getattr(err, "message", None)
    msg = str(raw if raw is not None else err or "").lower()
    return (
        "task" in msg and ("not found" in msg or "final" in msg or "terminal" in msg)
    ) or "cannot be continued" in msg
