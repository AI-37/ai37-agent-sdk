from __future__ import annotations

from typing import Literal, Protocol, TypedDict

# Роль пользователя в его организации (multi-user orgs, амендмент v2).
# USER < EDITOR < OWNER. Дефолт при отсутствии claim — USER (least-privilege).
OrgRole = Literal["OWNER", "EDITOR", "USER"]


class Claims(TypedDict, total=False):
    """Claims user-JWT (см. contract/claims.schema.json). v1.2: один issuer (sp-ai).

    ``org_role`` появляется с multi-user-организациями; ``org_id`` — id организации
    (расцеплён от ``sub``). Отсутствие ``org_role`` трактуется как ``USER``.
    """

    iss: str
    aud: str | list[str]
    sub: str
    exp: int
    iat: int
    nbf: int
    org_id: str
    billing_org_id: str
    app_id: str
    org_role: OrgRole
    email: str
    name: str


class JwtVerifier(Protocol):
    def verify(self, token: str) -> Claims: ...
