"""Владелец A2A-задачи — из проверенного JWT хода, одинаково на A2A- и AG-UI-пути.

TaskStore'ы ``a2a-sdk`` 1.x (``InMemoryTaskStore``, ``DatabaseTaskStore``) и наш
``RedisTaskStore`` разводят задачи по ``owner_resolver(context)``, по умолчанию
``context.user.user_name``. Аутентификацию делает ``AuthGuardMiddleware`` (ContextVar), а не
Starlette ``request.user``, поэтому стандартный ``ServerCallContextBuilder`` клал в контекст
``UnauthenticatedUser`` с пустым именем: все задачи всех пользователей лежали под одним владельцем.

Здесь пользователь собирается из ``AgentContext.claims`` хода: ``<org_id>:<sub>``. Без JWT
(``AI37_AUTH_REQUIRED=false``, системный вызов) — ``UnauthenticatedUser``, как раньше.
"""

from __future__ import annotations

from a2a.auth.user import UnauthenticatedUser, User
from a2a.server.context import ServerCallContext
from a2a.server.routes.common import DefaultServerCallContextBuilder
from starlette.requests import Request

from .als import current_ctx


class JwtUser(User):
    """Пользователь хода из проверенного JWT. ``user_name`` = ключ владельца задачи."""

    def __init__(self, sub: str, org_id: str | None) -> None:
        self.sub = sub
        self.org_id = org_id or ""

    @property
    def is_authenticated(self) -> bool:
        return True

    @property
    def user_name(self) -> str:
        return f"{self.org_id}:{self.sub}"


def current_user() -> User:
    """Пользователь текущего хода (ContextVar ``AuthGuardMiddleware``) или анонимный."""
    ctx = current_ctx()
    claims = getattr(ctx, "claims", None) or {}
    sub = claims.get("sub")
    if not sub:
        return UnauthenticatedUser()
    return JwtUser(str(sub), claims.get("org_id"))


def current_call_context() -> ServerCallContext:
    """``ServerCallContext`` для прямых обращений к TaskStore (AG-UI, REST-ручки агента)."""
    return ServerCallContext(user=current_user())


class HostCallContextBuilder(DefaultServerCallContextBuilder):
    """Контекст A2A-запроса с пользователем из JWT хода вместо Starlette ``request.user``."""

    def build_user(self, request: Request) -> User:
        user = current_user()
        if user.is_authenticated:
            return user
        return super().build_user(request)
