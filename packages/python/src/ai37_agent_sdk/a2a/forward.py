from __future__ import annotations

A2A_PROTOCOL_VERSION = "0.3"


def build_a2a_auth_headers(
    bearer_token: str,
    *,
    header_name: str = "Authorization",
    prefix: str = "Bearer",
    protocol_version: str | None = A2A_PROTOCOL_VERSION,
) -> dict[str, str]:
    """Заголовки forward user-JWT для A2A-вызова другого агента (РЕШЕНИЕ 2).

    Использовать при вызове downstream-агента: прокинуть тот же user-JWT + версию протокола.
    message.metadata (включая metadata.ai37) пробрасывается вызывающим кодом без изменений.

    ``protocol_version=None`` — без ``A2A-Version``: клиент ``a2a-sdk`` 1.x ставит его сам, и
    подмешанный ``0.3`` увёл бы запрос на сервере 1.x в legacy-обработчик.
    """
    headers = {header_name: f"{prefix} {bearer_token}"}
    if protocol_version is not None:
        headers["A2A-Version"] = protocol_version
    return headers
