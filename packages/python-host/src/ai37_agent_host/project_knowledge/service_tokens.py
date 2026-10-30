"""Служебный токен ``client_credentials`` — порт ``ts-host/src/project-knowledge/service-token.ts``.

Для фоновых задач, у которых нет пользователя: отчёт по расписанию грузится в пул проекта DS от
имени клиента Authentik (план project-knowledge-bridge, срез 2). Это не OIDC-логин и не обмен токена
пользователя: у клиента своя идентичность, а права ему задаёт политика DS.

Токен живёт в памяти процесса до истечения с запасом; параллельные вызовы ждут один запрос.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from dataclasses import dataclass
from typing import Any, Literal

import httpx

ServiceTokenErrorCode = Literal[
    # discovery не ответил или в нём нет token_endpoint.
    "discovery_failed",
    # Провайдер отказал (неверный клиент или секрет, grant не разрешён).
    "token_rejected",
    # В ответе нет access_token.
    "invalid_response",
    "network_error",
]

#: Без ``expires_in`` провайдер ничего не обещает: держим токен пять минут.
_DEFAULT_TTL_SECONDS = 300.0
#: Запас до истечения: токен не должен истечь в пути к DS.
_MAX_MARGIN_SECONDS = 60.0


class ServiceTokenError(Exception):
    """Ошибка получения токена. Секрет и тело ответа в текст не попадают."""

    def __init__(self, code: ServiceTokenErrorCode, status: int | None = None) -> None:
        super().__init__(f"service_token: {code}{f' (HTTP {status})' if status else ''}")
        self.code = code
        self.status = status


@dataclass(frozen=True)
class _CachedToken:
    token: str
    #: Момент (секунды эпохи), после которого берём новый токен, уже с запасом.
    refresh_at: float


_tokens: dict[str, _CachedToken] = {}
_locks: dict[str, asyncio.Lock] = {}
_token_endpoints: dict[str, str] = {}


def _now() -> float:
    return time.time()


async def service_token(
    *,
    issuer: str,
    client_id: str,
    client_secret: str,
    scope: str | None = None,
    http_client: httpx.AsyncClient | None = None,
    timeout: float = 15.0,
) -> str:
    """Access token клиента. ``token_endpoint`` — из discovery issuer'а (Authentik:
    ``https://auth…/application/o/<slug>/``). Повторный вызов до истечения сеть не трогает; после
    истечения (за минуту до него, у короткоживущих — за половину срока) берётся новый."""
    key = _cache_key(issuer, client_id, client_secret, scope)
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        cached = _tokens.get(key)
        if cached and _now() < cached.refresh_at:
            return cached.token
        http = _Http(http_client, timeout)
        endpoint = await _token_endpoint(http, issuer)
        fresh = await _request_token(http, endpoint, client_id, client_secret, scope)
        _tokens[key] = fresh
        return fresh.token


def _cache_key(issuer: str, client_id: str, client_secret: str, scope: str | None) -> str:
    """Секрет в ключе хешем: сменился секрет — нужен новый токен, а сам секрет не копится."""
    secret = hashlib.sha256(client_secret.encode("utf-8")).hexdigest()
    return "\n".join([issuer.rstrip("/"), client_id, scope or "", secret])


async def _token_endpoint(http: _Http, issuer: str) -> str:
    """token_endpoint из discovery; удачный ответ запоминается на весь процесс."""
    base = issuer.rstrip("/")
    known = _token_endpoints.get(base)
    if known:
        return known
    resp = await http.request("GET", f"{base}/.well-known/openid-configuration")
    if resp.status_code >= 400:
        raise ServiceTokenError("discovery_failed", resp.status_code)
    endpoint = _json(resp).get("token_endpoint")
    if not isinstance(endpoint, str) or not endpoint:
        raise ServiceTokenError("discovery_failed", resp.status_code)
    _token_endpoints[base] = endpoint
    return endpoint


async def _request_token(
    http: _Http, endpoint: str, client_id: str, client_secret: str, scope: str | None
) -> _CachedToken:
    form = {
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
    }
    if scope:
        form["scope"] = scope
    resp = await http.request("POST", endpoint, data=form)
    if resp.status_code >= 400:
        raise ServiceTokenError("token_rejected", resp.status_code)
    body = _json(resp)
    token = body.get("access_token")
    if not isinstance(token, str) or not token:
        raise ServiceTokenError("invalid_response", resp.status_code)
    expires_in = body.get("expires_in")
    ttl = float(expires_in) if isinstance(expires_in, int | float) and expires_in > 0 else None
    return _CachedToken(token=token, refresh_at=_now() + _refresh_after(ttl))


def _refresh_after(ttl: float | None) -> float:
    """Короткоживущему токену минута запаса велика: тогда запас — половина срока."""
    lifetime = ttl if ttl is not None else _DEFAULT_TTL_SECONDS
    return lifetime - min(_MAX_MARGIN_SECONDS, lifetime / 2)


class _Http:
    """Запросы с общим таймаутом и сетевой ошибкой SDK вместо исключения httpx."""

    def __init__(self, client: httpx.AsyncClient | None, timeout: float) -> None:
        self._client = client
        self._timeout = timeout

    async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        headers = {"Accept": "application/json"}
        try:
            if self._client is not None:
                return await self._client.request(
                    method, url, headers=headers, timeout=self._timeout, **kwargs
                )
            async with httpx.AsyncClient() as client:
                return await client.request(
                    method, url, headers=headers, timeout=self._timeout, **kwargs
                )
        except httpx.HTTPError as exc:
            raise ServiceTokenError("network_error") from exc


def _json(resp: httpx.Response) -> dict[str, Any]:
    try:
        data = resp.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}
