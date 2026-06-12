from __future__ import annotations

A2A_PROTOCOL_VERSION = "0.3"


def build_a2a_auth_headers(
    bearer_token: str,
    *,
    header_name: str = "Authorization",
    prefix: str = "Bearer",
    protocol_version: str = A2A_PROTOCOL_VERSION,
) -> dict[str, str]:
    """Заголовки forward user-JWT для A2A-вызова другого агента (РЕШЕНИЕ 2).

    Использовать при вызове downstream-агента: прокинуть тот же user-JWT + версию протокола.
    message.metadata (включая metadata.ai37) пробрасывается вызывающим кодом без изменений.
    """
    return {
        header_name: f"{prefix} {bearer_token}",
        "A2A-Version": protocol_version,
    }
