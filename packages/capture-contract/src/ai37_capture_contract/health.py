"""`GET /health` рендерера: жив ли, что умеет и через какие выходы ходит.

Форма browser-worker (`status`, `browser`, `proxies`, `capacity`, `exits`) сохранена, чтобы агент
читал оба вида рендереров одним кодом. Headed-слот добавляет, кто он и в каком состоянии: занятый
или закрытый сайтом слот жив, но работу давать ему не надо.
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class RendererKind(StrEnum):
    """Как рендерер открывает страницы."""

    #: Chromium в кластере: выход выбирается в каждом запросе.
    HEADLESS = "headless"
    #: Видимый Chrome на машине вне кластера: профиль и выход закреплены за слотом.
    HEADED = "headed"


class RendererState(StrEnum):
    """Состояние рендерера сверх «жив / мёртв»."""

    WARMING_UP = "warming_up"
    READY = "ready"
    #: Снимает пачку. Слот берёт одну пачку за раз — следующая получит 409.
    BUSY = "busy"
    #: Сайт закрыл адрес выхода («отключите VPN»). Проверяется заново при следующем запросе.
    SITE_BLOCKED = "site_blocked"
    BROWSER_DOWN = "browser_down"
    #: Выключен оператором.
    DISABLED = "disabled"


class RendererCapacity(BaseModel):
    """Сколько рендерер тянет разом. Прочие числа browser-worker проходят как есть."""

    model_config = ConfigDict(extra="allow")

    concurrency: int = Field(default=1, ge=1)


class ExitHealth(BaseModel):
    """Итог последней пробы выхода — метка, без адреса и логина."""

    model_config = ConfigDict(extra="allow")

    exit: str
    up: bool


class RendererHealth(BaseModel):
    """Тело `GET /health`."""

    status: str
    browser: bool
    proxies: list[str] = Field(default_factory=list)
    capacity: RendererCapacity = Field(default_factory=RendererCapacity)
    exits: list[ExitHealth] = Field(default_factory=list)
    kind: RendererKind = RendererKind.HEADLESS
    #: Метка слота `<машина>.<выход>`. Пусто — рендерер не слот (browser-worker).
    slot: str = ""
    state: RendererState = RendererState.READY
    #: Магазины, для которых сессия уже прогрета: очередь не гоняет подготовку заново.
    prepared_hosts: list[str] = Field(default_factory=list)
