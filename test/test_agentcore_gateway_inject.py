"""AgentCore Gateway session/new inject — never persisted to the agent file."""

from __future__ import annotations

import dataclasses
from typing import Any

import pytest

from kiro_crew.config import KiroCrewConfig
from kiro_crew.agent import _merge_edition_mcp
from kiro_crew.platform.agentcore_gateway import (
    GATEWAY_SERVER_NAME,
    sanitize_gateway_spec,
    session_gateway_servers,
    strip_secret_spec_keys,
)
from kiro_crew.platform.bootstrap import build_default_context
from kiro_crew.platform.context import reset_context, set_context
from kiro_crew.platform.defaults import DefaultAgentIdentityProvider
from kiro_crew.platform.governance import parse_policy


class _ForcedOn(DefaultAgentIdentityProvider):
    def __init__(self, spec: dict[str, Any] | None) -> None:
        self._spec = spec

    def enabled(self) -> bool:
        return True

    def gateway_mcp_spec(self) -> dict[str, object] | None:
        return self._spec


def _install(*, posture: str, spec: dict[str, Any] | None) -> None:
    base = build_default_context(KiroCrewConfig())
    ceiling = parse_policy(
        {
            "version": 1,
            "boot": {"fail_closed": True},
            "capabilities": {"agentcore": {"enabled": True, "posture": posture}},
        }
    )
    set_context(
        dataclasses.replace(
            base,
            agent_identity=_ForcedOn(spec),
            governance=ceiling,
        )
    )


def test_sanitize_drops_authorization_headers() -> None:
    cleaned = sanitize_gateway_spec(
        {
            "url": "https://gw.example.test/mcp",
            "headers": {"Authorization": "Bearer secret"},
            "Authorization": "Bearer secret",
        }
    )
    assert cleaned == {"url": "https://gw.example.test/mcp"}
    stripped = strip_secret_spec_keys({"url": "https://x", "headers": {"a": "b"}})
    assert "headers" not in stripped


def test_rebuild_never_writes_gateway_into_agent_file() -> None:
    try:
        _install(posture="workload", spec={"url": "http://127.0.0.1:18765/mcp"})
        mcp = {GATEWAY_SERVER_NAME: {"url": "https://stale.example.test/mcp"}}
        _merge_edition_mcp(mcp)
        assert GATEWAY_SERVER_NAME not in mcp
    finally:
        reset_context()


def test_rebuild_retracts_gateway_under_login_posture() -> None:
    try:
        _install(posture="login", spec={"url": "https://gw.example.test/mcp"})
        mcp = {GATEWAY_SERVER_NAME: {"url": "https://stale.example.test/mcp"}}
        _merge_edition_mcp(mcp)
        assert GATEWAY_SERVER_NAME not in mcp
    finally:
        reset_context()


def test_session_injects_loopback_only(monkeypatch: pytest.MonkeyPatch) -> None:
    from kiro_crew.platform.agentcore_sigv4 import PROXY_AUTH_HEADER

    monkeypatch.setattr(
        "kiro_crew.platform.agentcore_sigv4.workload_proxy_auth_token",
        lambda: "proxy-test-token",
    )
    try:
        _install(posture="workload", spec={"url": "http://127.0.0.1:18765/mcp"})
        servers = session_gateway_servers("agent:main:main")
        assert len(servers) == 1
        assert servers[0]["url"] == "http://127.0.0.1:18765/mcp"
        assert servers[0]["type"] == "http"
        assert servers[0]["headers"] == [
            {"name": PROXY_AUTH_HEADER, "value": "proxy-test-token"},
        ]
    finally:
        reset_context()


def test_session_withholds_loopback_without_proxy_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "kiro_crew.platform.agentcore_sigv4.workload_proxy_auth_token",
        lambda: None,
    )
    try:
        _install(posture="workload", spec={"url": "http://127.0.0.1:18765/mcp"})
        assert session_gateway_servers("agent:main:main") == []
    finally:
        reset_context()


def test_session_never_injects_unsigned_https() -> None:
    try:
        _install(posture="workload", spec={"url": "https://gw.example.test/mcp"})
        assert session_gateway_servers("agent:main:main") == []
    finally:
        reset_context()


def test_agentcore_gateway_inject_is_kiro_only() -> None:
    from kiro_crew.acp.types import (
        ACP_BACKEND_CLAUDE,
        ACP_BACKEND_KAS,
        ACP_BACKEND_KIRO,
        ACP_BACKENDS_AGENTCORE_GATEWAY,
    )

    assert ACP_BACKENDS_AGENTCORE_GATEWAY == frozenset({ACP_BACKEND_KIRO})
    assert ACP_BACKEND_CLAUDE not in ACP_BACKENDS_AGENTCORE_GATEWAY
    assert ACP_BACKEND_KAS not in ACP_BACKENDS_AGENTCORE_GATEWAY
    from kiro_crew.acp.client import AcpClient

    source = AcpClient._pooled_mcp_servers.__code__.co_names
    assert "ACP_BACKENDS_AGENTCORE_GATEWAY" in source


def test_session_empty_without_session_key() -> None:
    try:
        _install(posture="workload", spec={"url": "http://127.0.0.1:9/mcp"})
        assert session_gateway_servers("") == []
    finally:
        reset_context()
