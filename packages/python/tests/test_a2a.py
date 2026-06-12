from ai37_agent_sdk import A2A_PROTOCOL_VERSION, build_a2a_auth_headers


def test_build_headers():
    headers = build_a2a_auth_headers("abc.jwt")
    assert headers["Authorization"] == "Bearer abc.jwt"
    assert headers["A2A-Version"] == A2A_PROTOCOL_VERSION


def test_custom_header_name():
    headers = build_a2a_auth_headers("t", header_name="X-Auth", prefix="Token")
    assert headers["X-Auth"] == "Token t"
