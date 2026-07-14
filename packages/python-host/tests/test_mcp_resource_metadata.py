"""Тесты protected-resource-metadata (RFC 9728): URL-деривация + сборка тела + роуты."""

from __future__ import annotations

from ai37_agent_host.mcp import (
    ProtectedResourceMetadataOptions,
    build_protected_resource_metadata,
    protected_resource_metadata_routes,
    protected_resource_metadata_url,
)


def test_metadata_url_moves_path_into_wellknown_suffix():
    assert (
        protected_resource_metadata_url("https://h.app.sp-ai.ru/mcp")
        == "https://h.app.sp-ai.ru/.well-known/oauth-protected-resource/mcp"
    )


def test_metadata_url_root_path_has_no_suffix():
    assert (
        protected_resource_metadata_url("https://h.app.sp-ai.ru/")
        == "https://h.app.sp-ai.ru/.well-known/oauth-protected-resource"
    )


def test_build_body_full():
    body = build_protected_resource_metadata(
        ProtectedResourceMetadataOptions(
            resource="https://h/mcp",
            authorization_servers=["https://auth/"],
            scopes_supported=["a", "b"],
            resource_name="Elevator",
        )
    )
    assert body == {
        "resource": "https://h/mcp",
        "authorization_servers": ["https://auth/"],
        "scopes_supported": ["a", "b"],
        "resource_name": "Elevator",
        "bearer_methods_supported": ["header"],
    }


def test_build_body_omits_empty_scopes_and_name():
    body = build_protected_resource_metadata(
        ProtectedResourceMetadataOptions(
            resource="https://h/mcp",
            authorization_servers=[],
        )
    )
    assert "scopes_supported" not in body
    assert "resource_name" not in body
    assert body["bearer_methods_supported"] == ["header"]
    assert body["authorization_servers"] == []


def test_routes_serve_both_root_and_suffix():
    routes = protected_resource_metadata_routes(
        ProtectedResourceMetadataOptions(
            resource="https://h/mcp", authorization_servers=["https://auth/"]
        )
    )
    paths = {r.path for r in routes}
    assert "/.well-known/oauth-protected-resource" in paths
    assert "/.well-known/oauth-protected-resource/mcp" in paths


def test_routes_single_when_root_resource():
    routes = protected_resource_metadata_routes(
        ProtectedResourceMetadataOptions(
            resource="https://h/", authorization_servers=[]
        )
    )
    paths = [r.path for r in routes]
    assert paths == ["/.well-known/oauth-protected-resource"]
