"""Тексты файлов хода в общий бюджет и извлечение одним LLM-вызовом — порт
``ts-host/src/attachments/{contents,extract}.ts``.

Для агентов, которые отдают документ модели целиком: извлечь данные, проверить документ
пользователя. Почему не агентная петля с виртуальной ФС: в elevator она проходила около 25
итераций на ход и не укладывалась в 60 секунд ingress, а тексты уже лежат в chat-backend готовым
markdown — их проще прочитать кодом и отдать модели за один раз.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from typing import Any, Literal

from ..llm import create_openai_client, resolve_llm_config
from .attachment_readers import AttachmentReaders, FailureReason, attachment_failure_reason


@dataclass(frozen=True)
class AttachmentContent:
    ref: str
    name: str
    content: str
    #: Текст обрезан по бюджету: ответ по нему неполный, и об этом надо сказать.
    truncated: bool


@dataclass(frozen=True)
class AttachmentReadFailure:
    ref: str
    scope: Literal["chat", "project"]
    reason: FailureReason
    #: Текст ошибки бэкенда: в нём fileId и HTTP-статус. Имени файла здесь нет, у клиента это ПДн.
    detail: str


@dataclass(frozen=True)
class AttachmentContentsResult:
    contents: list[AttachmentContent] = field(default_factory=list)
    failures: list[AttachmentReadFailure] = field(default_factory=list)


async def read_attachment_contents(
    readers: AttachmentReaders, *, budget_chars: int | None = None
) -> AttachmentContentsResult:
    """Все файлы хода в общий бюджет символов (по умолчанию без потолка). Ошибка одного файла не
    роняет остальные, но возвращается с причиной. Пустые файлы (скан без текстового слоя) в
    результат не попадают: в них нечего читать."""
    result = AttachmentContentsResult()
    budget = sys.maxsize if budget_chars is None else budget_chars
    for file in readers.scope.files:
        if budget <= 0:
            break
        read = await readers.read_within_budget(file.ref, budget)
        if read.error:
            result.failures.append(
                AttachmentReadFailure(
                    ref=file.ref,
                    scope=file.scope,
                    reason=attachment_failure_reason(read.error),
                    detail=read.error,
                )
            )
            continue
        content = read.content.strip()
        if not content:
            continue
        result.contents.append(
            AttachmentContent(
                ref=file.ref, name=file.name, content=content, truncated=read.truncated
            )
        )
        budget -= len(content)
    return result


_NO_DATA = re.compile(r"^нет данных\.?$", re.IGNORECASE)
_CUT = ' обрезан="да"'


async def extract_from_attachments(
    *,
    system_prompt: str,
    query: str,
    contents: list[AttachmentContent],
    model: str,
    api_key: str | None = None,
    base_url: str | None = None,
    max_tokens: int | None = None,
    extra_body: dict[str, Any] | None = None,
    timeout_s: float = 300.0,
    client: Any | None = None,
) -> str | None:
    """Извлечение данных из файлов хода. Доменную часть задаёт агент ``system_prompt``; он должен
    велеть ответить ровно «нет данных», если нужного нет, — такой ответ превращается в None.

    Ключ и endpoint по умолчанию — ``ctx.llm_key`` и ``LITELLM_BASE_URL`` (как у
    :func:`create_openai_client`). ``extra_body`` — доп. поля запроса LiteLLM (например,
    ``reasoning_effort``). Ошибки вызова не глотаются: продолжать ли ход без файлов, решает агент.
    """
    if not contents:
        return None
    llm = client or create_openai_client(
        resolve_llm_config(api_key=api_key, base_url=base_url, model=model)
    )
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": extraction_request(query, contents)},
        ],
        "temperature": 0,
        "timeout": timeout_s,
    }
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    if extra_body:
        kwargs["extra_body"] = extra_body
    response = await llm.chat.completions.create(**kwargs)
    text = message_text(response).strip()
    return None if not text or _NO_DATA.match(text) else text


def extraction_request(query: str, contents: list[AttachmentContent]) -> str:
    """Запрос пользователя и тексты файлов блоками с именами (формат совпадает с TS-хостом)."""
    blocks = "\n\n".join(
        f'<файл имя="{file.name}"{_CUT if file.truncated else ""}>\n{file.content}\n</файл>'
        for file in contents
    )
    return f'Запрос пользователя: "{query}".\n\nСодержимое приложенных файлов:\n\n{blocks}'


def message_text(response: Any) -> str:
    """Текст ответа OpenAI-совместимого API. Пустой content — смотрим ``reasoning_content``:
    адаптер deepseek в LiteLLM при выключенном thinking кладёт туда весь ответ."""
    choices = getattr(response, "choices", None) or []
    message = getattr(choices[0], "message", None) if choices else None
    content = getattr(message, "content", None)
    if isinstance(content, str) and content:
        return content
    reasoning = getattr(message, "reasoning_content", None)
    return reasoning if isinstance(reasoning, str) else ""
