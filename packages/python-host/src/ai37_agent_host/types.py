"""Контракты host'а — порт ``ts-host/src/types.ts``.

Host не знает про «ноды» агента — он знает про :class:`AgentHandler`: принять
нормализованный вход + verified :class:`AgentContext` → вернуть :class:`AgentResult`.
Вся когниция (intent/work/critic/respond) — внутри handler'а конкретного агента.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from ai37_agent_sdk import AgentContext, Claims

AgentChannel = Literal["web", "widget", "revit"]


@dataclass
class OutputNegotiation:
    """Резолвнутая хостом негоциация вывода (две оси, РЕШЕНИЕ 10).

    ``text`` — формат текста, ЕСЛИ агент его эмитит; ``catalog_id`` — согласованный
    каталог A2UI или ``None`` (тогда A2UI не строим).
    """

    text: str
    catalog_ids: list[str]
    catalog_id: str | None


@dataclass
class IntentEnvelope:
    skill: str
    params: dict[str, Any] | None = None


@dataclass
class ContextFile:
    """Манифест-хинт одного приложенного файла (в ``metadata.ai37.context_files``).

    Даёт агенту ИМЯ файла (+summary) без manifest-round-trip к store; тело файла тянется
    отдельно через store по ``ref`` (см. ``store_backend.file_context.context_file_path``).
    """

    #: ``project-attachment:<id>`` | ``chat-attachment:<id>`` (как элементы ``context_refs``).
    ref: str
    #: Имя файла (sourceName) — по нему LLM решает, читать ли тело.
    name: str
    #: Откуда файл: durable-полка проекта или эфемерное вложение чата.
    scope: Literal["project", "chat"]
    #: Краткая выжимка для дисамбигуации.
    summary: str | None = None
    #: Большой файл — читать грепом/окнами, не целиком.
    is_large: bool | None = None


@dataclass
class Ai37Metadata:
    """Конверт ``metadata.ai37`` (04-a2a-conventions.md)."""

    tenant: str | None = None
    app_id: str | None = None
    channel: AgentChannel | None = None
    thread_id: str | None = None
    session_id: str | None = None
    context_refs: list[str] | None = None
    context_files: list[ContextFile] | None = None
    intent: IntentEnvelope | None = None
    trace_id: str | None = None
    #: Принимаемые клиентом форматы текста — носитель ТОЛЬКО для AG-UI (`forwardedProps.ai37`).
    #: Для A2A носитель — нативный `params.configuration.acceptedOutputModes`.
    accepted_output_modes: list[str] | None = None


@dataclass
class A2uiComponent:
    """Декларативный UI-компонент A2UI — УЗЕЛ ДЕРЕВА.

    Host уплощает его в плоский список операций (``a2ui.component_to_a2ui_operations``):
    протокол v0.9 не допускает inline-вложенность, дети — по id-ссылкам.
    """

    component: str
    #: Скалярные props (без слотов детей — они в ``children``).
    props: dict[str, Any] = field(default_factory=dict)
    #: Опциональный id узла; если не задан — генерируется при уплощении (корень → ``root``).
    id: str | None = None
    #: Каталог surface (имеет смысл только для верхнего компонента). ``None`` → первичный каталог.
    catalog_id: str | None = None
    #: Дочерние компоненты по слотам: ключ — prop, в который уплощатель кладёт id-ссылку.
    children: dict[str, A2uiComponent | list[A2uiComponent]] | None = None


AgentStatus = Literal["completed", "input-required", "failed"]


@dataclass
class A2uiAction:
    """Действие пользователя над A2UI-компонентом (клик/submit)."""

    name: str
    context: dict[str, Any] = field(default_factory=dict)
    surface_id: str | None = None
    source_component_id: str | None = None


@dataclass
class AgentInput:
    """Нормализованный вход (из A2A-сообщения или AG-UI-тела)."""

    data: dict[str, Any]
    metadata: Ai37Metadata
    task_id: str
    context_id: str
    negotiation: OutputNegotiation
    text: str | None = None
    action: A2uiAction | None = None
    claims: Claims | None = None
    billing_org_id: str | None = None
    accepted_output_modes: list[str] | None = None
    supported_catalog_ids: list[str] | None = None
    #: Персистентное состояние прошлого хода этого task (HITL/мастер), host достаёт из task-store.
    task_state: dict[str, Any] | None = None


# --- AgentEvent: дискриминированный union для стрима прогресса/COT (AG-UI) ---


@dataclass
class NodeEvent:
    node: str
    type: Literal["node"] = "node"


@dataclass
class TextEvent:
    delta: str
    type: Literal["text"] = "text"


@dataclass
class A2uiEvent:
    component: A2uiComponent
    type: Literal["a2ui"] = "a2ui"


@dataclass
class ReasoningEvent:
    delta: str
    type: Literal["reasoning"] = "reasoning"


@dataclass
class ToolEvent:
    phase: Literal["start", "end"]
    name: str
    id: str | None = None
    args: Any = None
    result: Any = None
    type: Literal["tool"] = "tool"


AgentEvent = NodeEvent | TextEvent | A2uiEvent | ReasoningEvent | ToolEvent


@dataclass
class AgentResult:
    status: AgentStatus
    a2ui: list[A2uiComponent] | None = None
    message: str | None = None
    result: Any = None
    #: для input-required — карточка-вопрос пользователю (HITL).
    followup: A2uiComponent | None = None
    #: Состояние для следующего хода — host персистит в ``task.metadata.state``.
    state: dict[str, Any] | None = None


@dataclass
class AgentRequest:
    input: AgentInput
    #: стрим промежуточных событий (AG-UI). Для A2A non-stream — no-op.
    emit: Callable[[AgentEvent], None]
    #: verified context из ai37-agent-sdk (claims + billing). ``None`` при auth.required=false.
    ctx: AgentContext | None = None


class AgentHandler(Protocol):
    """Когниция агента. Реализуется в каждом агенте; host её вызывает."""

    async def run(self, req: AgentRequest) -> AgentResult: ...
