from __future__ import annotations

from typing import Literal

# ``forbidden_role`` — аутентифицирован, но роли недостаточно (семантика 403, не 401).
AuthErrorCode = Literal["invalid_token", "missing_claim", "config", "forbidden_role"]


class AuthError(Exception):
    """Ошибка аутентификации. ``code`` — машинно-читаемая причина."""

    def __init__(
        self,
        message: str,
        code: AuthErrorCode = "invalid_token",
        *,
        cause: object | None = None,
    ) -> None:
        super().__init__(message)
        self.code: AuthErrorCode = code
        if cause is not None:
            self.__cause__ = cause if isinstance(cause, BaseException) else None
