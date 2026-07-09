"""Сборка HTTP-приложения агента — порт ``ts-host/src/createAgentHost.ts``.

На ``a2a-sdk`` 1.x + FastAPI (wiring по образцу Minstroy ``app/api/a2a/router.py``):
``DefaultRequestHandlerV2`` + ``create_jsonrpc_routes``/``create_rest_routes`` + agent-card,
всё за ``AuthGuardMiddleware`` (verified ``AgentContext`` в ALS).

Новый агент = ``create_agent_host(card=..., handler=..., agent_context=...)``.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from a2a.server.request_handlers.default_request_handler_v2 import DefaultRequestHandlerV2
from a2a.server.routes.agent_card_routes import agent_card_to_dict
from a2a.server.routes.jsonrpc_routes import create_jsonrpc_routes
from a2a.server.routes.rest_routes import create_rest_routes
from a2a.server.tasks.inmemory_task_store import InMemoryTaskStore
from a2a.types import AgentCard
from ai37_agent_sdk import AgentContextSettings
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from google.protobuf.json_format import ParseDict

from .a2a_executor import HostExecutor
from .auth_guard import AuthGuardMiddleware
from .types import AgentHandler


def _as_agent_card(card: AgentCard | dict[str, Any]) -> AgentCard:
    if isinstance(card, AgentCard):
        return card
    return ParseDict(card, AgentCard(), ignore_unknown_fields=True)


def create_agent_host(
    *,
    card: AgentCard | dict[str, Any],
    handler: AgentHandler,
    agent_context: AgentContextSettings,
    base_path: str = "/a2a/v1",
    catalog_id: str | list[str] | None = None,
    build_info: dict[str, Any] | None = None,
    task_store: Any = None,
) -> FastAPI:
    """FastAPI-приложение агента: health + agent-card + A2A JSON-RPC/REST за guard'ом."""
    app = FastAPI()
    info = dict(build_info or {})
    agent_card = _as_agent_card(card)
    card_dict = agent_card_to_dict(agent_card)
    # protobuf AgentCard не имеет слота под расширения (x-ai37) и top-level url/protocolVersion —
    # ParseDict их отбрасывает. Возвращаем их из исходного dict в ОТДАВАЕМЫЙ card-JSON (иначе
    # orchestrator-фильтр по x-ai37.billing.{feature,privilege} и клиентский url потерялись бы).
    if isinstance(card, dict):
        for key, value in card.items():
            if key.startswith("x-") or (key in ("url", "protocolVersion") and key not in card_dict):
                card_dict[key] = value
    # Content-negotiation: текст = card.defaultOutputModes; каталог(и) = catalog_id.
    agent_text_modes = [
        m for m in (card_dict.get("defaultOutputModes") or []) if isinstance(m, str)
    ]

    store = task_store or InMemoryTaskStore()
    request_handler = DefaultRequestHandlerV2(
        agent_executor=HostExecutor(handler, agent_text_modes, catalog_id),
        task_store=store,
        agent_card=agent_card,
    )

    @app.get("/api/v1/health")
    async def _health() -> dict[str, Any]:
        return {"status": "ok", **info}

    @app.get("/api/v1/version")
    async def _version() -> dict[str, Any]:
        return dict(info)

    @app.get("/.well-known/agent-card.json")
    async def _agent_card() -> JSONResponse:
        body = json.dumps(card_dict, sort_keys=True).encode("utf-8")
        return JSONResponse(
            content=card_dict,
            headers={
                "Cache-Control": "public, max-age=300",
                "ETag": hashlib.sha256(body).hexdigest(),
            },
        )

    app.router.routes.extend(
        [
            *create_jsonrpc_routes(
                request_handler=request_handler, rpc_url=base_path, enable_v0_3_compat=True
            ),
            *create_rest_routes(
                request_handler=request_handler, enable_v0_3_compat=True, path_prefix=base_path
            ),
        ]
    )

    app.add_middleware(
        AuthGuardMiddleware,
        settings=agent_context,
        required=agent_context.auth.required,
        guarded_prefixes=[base_path, "/agui", "/mcp"],
    )
    return app
