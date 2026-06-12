from __future__ import annotations

from typing import Protocol, TypedDict


class Claims(TypedDict, total=False):
    """Claims user-JWT (см. contract/claims.schema.json). v1.2: один issuer (sp-ai)."""

    iss: str
    aud: str | list[str]
    sub: str
    exp: int
    iat: int
    nbf: int
    org_id: str
    billing_org_id: str
    app_id: str
    email: str
    name: str


class JwtVerifier(Protocol):
    def verify(self, token: str) -> Claims: ...
