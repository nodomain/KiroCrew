"""AgentCore unattended Gateway policy — login never attaches; user/OBO fail closed."""

from __future__ import annotations

import dataclasses
import json
import logging
from typing import Any

import pytest

from kiro_crew.config import KiroCrewConfig
from kiro_crew.platform.bootstrap import build_default_context
from kiro_crew.platform.context import set_context
from kiro_crew.platform.defaults import DefaultAgentIdentityProvider
from kiro_crew.platform.governance import parse_policy
from kiro_crew.platform.interfaces import InboundToken, SessionPrincipal

_GATEWAY_URL = "https://gateway.example.test/mcp"
_TOKEN = "sltok-unattended-must-not-leak"


class _CompanionIdentity(DefaultAgentIdentityProvider):
    def __init__(
        self,
        *,
        spec: dict[str, Any] | None = None,
        token: InboundToken | None = None,
        kind: str = "m2m",
        vaulted: bool = False,
    ) -> None:
        self._spec = spec
        self._token = token
        self._kind = kind
        self._vaulted = vaulted

    def enabled(self) -> bool:
        return True

    def gateway_mcp_spec(self) -> dict[str, object] | None:
        return self._spec

    def status(self) -> dict[str, object]:
        return {"credentialKind": self._kind, "vaultedOwnerToken": self._vaulted}

    async def vend_gateway_inbound_token(self, principal: SessionPrincipal) -> InboundToken | None:
        return self._token


def _ceiling(*, posture: str) -> Any:
    return parse_policy(
        {
            "version": 1,
            "boot": {"fail_closed": True},
            "capabilities": {"agentcore": {"enabled": True, "posture": posture}},
        }
    )


def _install(
    *,
    posture: str,
    kind: str = "m2m",
    vaulted: bool = False,
    token: InboundToken | None = None,
) -> None:
    base = build_default_context(KiroCrewConfig())
    set_context(
        dataclasses.replace(
            base,
            agent_identity=_CompanionIdentity(
                spec={"url": _GATEWAY_URL},
                token=token
                or InboundToken(
                    scheme="bearer",
                    token=_TOKEN,
                    expires_at=4_000_000_000.0,
                    audience="g",
                ),
                kind=kind,
                vaulted=vaulted,
            ),
            governance=_ceiling(posture=posture),
        )
    )


def _cron() -> SessionPrincipal:
    return SessionPrincipal(surface="cron", subject="cron+owner", session_key="cron:job1")


def _dashboard() -> SessionPrincipal:
    return SessionPrincipal(
        surface="dashboard", subject="dashboard+alice", session_key="dashboard:1"
    )


@pytest.mark.asyncio
async def test_login_cron_never_attaches_gateway() -> None:
    from kiro_crew.platform.agentcore_gateway import (
        attach_gateway_inbound,
        inbound_sidecar_path,
        session_gateway_servers,
    )

    _install(posture="login", kind="user")
    path = await attach_gateway_inbound(_cron())
    assert path is None
    assert inbound_sidecar_path("cron:job1").exists() is False
    assert session_gateway_servers("cron:job1") == []


@pytest.mark.asyncio
async def test_login_dashboard_still_attaches_when_vend_works() -> None:
    from kiro_crew.platform.agentcore_gateway import (
        attach_gateway_inbound,
        inbound_sidecar_path,
    )

    _install(posture="login", kind="user")
    path = await attach_gateway_inbound(_dashboard())
    assert path == inbound_sidecar_path("dashboard:1")
    assert path is not None and path.exists()


@pytest.mark.asyncio
async def test_workload_user_without_vault_retracts_gateway() -> None:
    from kiro_crew.platform.agentcore_gateway import (
        attach_gateway_inbound,
        inbound_sidecar_path,
        session_gateway_servers,
    )
    from kiro_crew.sel import sel

    _install(posture="workload", kind="user", vaulted=False)
    assert await attach_gateway_inbound(_cron()) is None
    sidecar = json.loads(inbound_sidecar_path("cron:job1").read_text(encoding="utf-8"))
    assert sidecar["denied"] is True
    assert _TOKEN not in json.dumps(sidecar)
    injected = session_gateway_servers("cron:job1")
    from kiro_crew.platform.agentcore_gateway import ACP_DENIED_PLACEHOLDER_URL, acp_http_server

    assert injected == [acp_http_server(ACP_DENIED_PLACEHOLDER_URL, disabled=True)]
    events = [
        e for e in sel().recent(limit=50) if e.get("operation") == "agentcore.unattended_denied"
    ]
    assert events
    assert events[0].get("outcome") == "denied"
    assert _TOKEN not in json.dumps(events)


@pytest.mark.asyncio
async def test_workload_m2m_cron_keeps_agent_file_gateway() -> None:
    from kiro_crew.platform.agentcore_gateway import (
        attach_gateway_inbound,
        inbound_sidecar_path,
        session_gateway_servers,
    )

    _install(posture="workload", kind="m2m")
    assert await attach_gateway_inbound(_cron()) is None
    assert inbound_sidecar_path("cron:job1").exists() is False
    # Companion https spec is the unsigned hostname — keep the agent-file
    # Gateway rather than injecting it unsigned onto session/new.
    assert session_gateway_servers("cron:job1") == []


@pytest.mark.asyncio
async def test_workload_m2m_cron_injects_live_loopback_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from kiro_crew.platform.agentcore_gateway import (
        attach_gateway_inbound,
        inbound_sidecar_path,
        session_gateway_servers,
    )
    from kiro_crew.platform.agentcore_sigv4 import PROXY_AUTH_HEADER

    listen = "http://127.0.0.1:18765/mcp"
    monkeypatch.setattr(
        "kiro_crew.platform.agentcore_sigv4.workload_proxy_auth_token",
        lambda: "proxy-test-token",
    )
    base = build_default_context(KiroCrewConfig())
    set_context(
        dataclasses.replace(
            base,
            agent_identity=_CompanionIdentity(spec={"url": listen}, kind="m2m"),
            governance=_ceiling(posture="workload"),
        )
    )
    assert await attach_gateway_inbound(_cron()) is None
    assert inbound_sidecar_path("cron:job1").exists() is False
    from kiro_crew.platform.agentcore_gateway import acp_http_server

    assert session_gateway_servers("cron:job1") == [
        acp_http_server(listen, headers={PROXY_AUTH_HEADER: "proxy-test-token"})
    ]


@pytest.mark.asyncio
async def test_workload_user_with_vault_allows_unattended() -> None:
    from kiro_crew.platform.agentcore_gateway import (
        attach_gateway_inbound,
        inbound_sidecar_path,
        session_gateway_servers,
    )

    _install(posture="workload", kind="user", vaulted=True)
    assert await attach_gateway_inbound(_cron()) is None
    assert inbound_sidecar_path("cron:job1").exists() is False
    assert session_gateway_servers("cron:job1") == []


@pytest.mark.asyncio
async def test_unknown_credential_kind_fail_closed_for_unattended() -> None:
    from kiro_crew.platform.agentcore_gateway import attach_gateway_inbound, session_gateway_servers

    _install(posture="workload", kind="", vaulted=False)
    await attach_gateway_inbound(_cron())
    injected = session_gateway_servers("cron:job1")
    assert injected and injected[0].get("disabled") is True


@pytest.mark.asyncio
async def test_unattended_deny_never_logs_token(caplog: pytest.LogCaptureFixture) -> None:
    from kiro_crew.platform.agentcore_gateway import attach_gateway_inbound
    from kiro_crew.sel import sel

    _install(posture="login", kind="user")
    caplog.set_level(logging.DEBUG)
    await attach_gateway_inbound(_cron())
    assert _TOKEN not in caplog.text
    blob = json.dumps(sel().recent(limit=50))
    assert _TOKEN not in blob


@pytest.mark.asyncio
async def test_taskrunner_prefix_is_unattended() -> None:
    from kiro_crew.platform.agentcore_gateway import attach_gateway_inbound, session_gateway_servers

    _install(posture="login", kind="user")
    principal = SessionPrincipal(
        surface="taskrunner",
        subject="taskrunner+owner",
        session_key="taskrunner:run1",
    )
    await attach_gateway_inbound(principal)
    assert session_gateway_servers("taskrunner:run1") == []


class _Sessions:
    def set_principal(self, key: str, principal: SessionPrincipal) -> None:
        return None


@pytest.mark.asyncio
async def test_unattended_bind_attach_error_writes_deny_sidecar(monkeypatch) -> None:
    from kiro_crew.platform.agent_identity import bind_session_principal
    from kiro_crew.platform.agentcore_gateway import (
        inbound_sidecar_path,
        session_gateway_servers,
    )
    from kiro_crew.sel import sel

    _install(posture="workload", kind="user", vaulted=False)

    async def _boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("attach exploded")

    monkeypatch.setattr(
        "kiro_crew.platform.agentcore_gateway.attach_gateway_inbound",
        _boom,
    )
    await bind_session_principal(
        _Sessions(), surface="cron", raw_id="owner", session_key="cron:job1"
    )
    sidecar = json.loads(inbound_sidecar_path("cron:job1").read_text(encoding="utf-8"))
    assert sidecar["denied"] is True
    assert sidecar.get("reason") == "attach_failed"
    assert _TOKEN not in json.dumps(sidecar)
    injected = session_gateway_servers("cron:job1")
    from kiro_crew.platform.agentcore_gateway import ACP_DENIED_PLACEHOLDER_URL, acp_http_server

    assert injected == [acp_http_server(ACP_DENIED_PLACEHOLDER_URL, disabled=True)]
    events = [
        e for e in sel().recent(limit=50) if e.get("operation") == "agentcore.unattended_denied"
    ]
    assert events
    assert events[0].get("outcome") == "denied"
    assert _TOKEN not in json.dumps(events)


@pytest.mark.asyncio
async def test_dashboard_bind_attach_error_does_not_write_deny_sidecar(monkeypatch) -> None:
    from kiro_crew.platform.agent_identity import bind_session_principal
    from kiro_crew.platform.agentcore_gateway import inbound_sidecar_path

    _install(posture="workload", kind="user", vaulted=False)

    async def _boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("attach exploded")

    monkeypatch.setattr(
        "kiro_crew.platform.agentcore_gateway.attach_gateway_inbound",
        _boom,
    )
    await bind_session_principal(
        _Sessions(), surface="dashboard", raw_id="alice", session_key="dashboard:1"
    )
    assert inbound_sidecar_path("dashboard:1").exists() is False
