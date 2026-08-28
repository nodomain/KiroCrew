"""Login-posture rebuild withholds non-managed MCP."""

from __future__ import annotations

import dataclasses
import json
import sys
from pathlib import Path
from typing import Any

import pytest

from kiro_crew.config import KiroCrewConfig
from kiro_crew.platform.bootstrap import build_default_context
from kiro_crew.platform.context import reset_context, set_context
from kiro_crew.platform.defaults import DefaultAgentIdentityProvider
from kiro_crew.platform.governance import parse_policy


class _ForcedOnIdentity(DefaultAgentIdentityProvider):
    def enabled(self) -> bool:
        return True


def _ceiling(*, posture: str) -> Any:
    return parse_policy(
        {
            "version": 1,
            "boot": {"fail_closed": True},
            "capabilities": {"agentcore": {"enabled": True, "posture": posture}},
        }
    )


def _enable(posture: str, *, identity_on: bool = True) -> None:
    base = build_default_context(KiroCrewConfig())
    adapter = _ForcedOnIdentity() if identity_on else DefaultAgentIdentityProvider()
    set_context(
        dataclasses.replace(base, agent_identity=adapter, governance=_ceiling(posture=posture))
    )


def _seed_rebuild_sources(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolate kiro-cli home + agent dir; seed dummy servers. Never writes ~/.kiro."""
    kiro_dir = tmp_path / ".kiro" / "agents"
    kiro_dir.mkdir(parents=True)
    settings_dir = tmp_path / ".kiro" / "settings"
    settings_dir.mkdir(parents=True)
    (settings_dir / "mcp.json").write_text(
        json.dumps({"mcpServers": {"dummy-kiro-global": {"command": "dummy-srv"}}}),
        encoding="utf-8",
    )
    seam_global = tmp_path / "seam-global.json"
    seam_global.write_text(
        json.dumps({"mcpServers": {"dummy-seam-global": {"command": "dummy-srv"}}}),
        encoding="utf-8",
    )
    from kiro_crew.config import config_dir

    crew_mcp = config_dir() / "mcp.json"
    crew_mcp.write_text(
        json.dumps({"mcpServers": {"dummy-crew-store": {"command": "dummy-srv"}}}),
        encoding="utf-8",
    )
    leftover = kiro_dir / "kirocrew.json"
    leftover.write_text(
        json.dumps(
            {
                "name": "kirocrew",
                "mcpServers": {"dummy-leftover": {"command": "dummy-srv"}},
                "tools": ["@dummy-leftover"],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr("kiro_crew.agent.KIRO_AGENTS_DIR", kiro_dir)
    monkeypatch.setattr("kiro_crew.agent._KIRO_MCP_JSON", settings_dir / "mcp.json")
    monkeypatch.setattr("kiro_crew.agent._CC_MCP_JSON", tmp_path / "nonexistent_cc.json")
    monkeypatch.setattr("kiro_crew.agent._KIROCREW_BIN", sys.executable)
    monkeypatch.setattr("kiro_crew.agent._extra_mcp_scope_globals", lambda: [seam_global])
    monkeypatch.setattr("shutil.which", lambda cmd, path=None: sys.executable)
    return kiro_dir


def test_login_rebuild_withholds_kiro_global(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kiro_crew.agent import rebuild_agent_config

    kiro_dir = _seed_rebuild_sources(tmp_path, monkeypatch)
    try:
        _enable("login")
        rebuild_agent_config()
    finally:
        reset_context()

    servers = (
        json.loads((kiro_dir / "kirocrew.json").read_text(encoding="utf-8")).get("mcpServers") or {}
    )
    assert "kirocrew-core" in servers
    assert "dummy-kiro-global" not in servers
    assert "dummy-seam-global" not in servers
    assert "dummy-crew-store" not in servers
    # Leftover custom MCP in the generated agent file is retracted so
    # login sessions do not remount it. Crew/kiro mcp.json stay intact.
    assert "dummy-leftover" not in servers
    tools = json.loads((kiro_dir / "kirocrew.json").read_text(encoding="utf-8")).get("tools") or []
    assert "@dummy-leftover" not in tools


def test_login_rebuild_withholds_without_companion_adapter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kiro_crew.agent import rebuild_agent_config

    kiro_dir = _seed_rebuild_sources(tmp_path, monkeypatch)
    try:
        _enable("login", identity_on=False)
        rebuild_agent_config()
    finally:
        reset_context()

    servers = (
        json.loads((kiro_dir / "kirocrew.json").read_text(encoding="utf-8")).get("mcpServers") or {}
    )
    assert "dummy-kiro-global" not in servers
    assert "kirocrew-core" in servers


def test_workload_rebuild_still_merges_kiro_global(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kiro_crew.agent import rebuild_agent_config

    kiro_dir = _seed_rebuild_sources(tmp_path, monkeypatch)
    try:
        _enable("workload")
        rebuild_agent_config()
    finally:
        reset_context()

    servers = (
        json.loads((kiro_dir / "kirocrew.json").read_text(encoding="utf-8")).get("mcpServers") or {}
    )
    assert "dummy-kiro-global" in servers
    assert "kirocrew-core" in servers


def test_login_probe_succeeds_iam_invoke_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kiro_crew.agent import rebuild_agent_config
    from kiro_crew.cloud import iam
    from kiro_crew.sel import sel

    kiro_dir = _seed_rebuild_sources(tmp_path, monkeypatch)
    monkeypatch.setattr(iam, "probe_instance_invoke_gateway", lambda: True)
    try:
        _enable("login")
        rebuild_agent_config()
        events = sel().recent(limit=50)
    finally:
        reset_context()

    servers = (
        json.loads((kiro_dir / "kirocrew.json").read_text(encoding="utf-8")).get("mcpServers") or {}
    )
    mismatch = [e for e in events if e.get("operation") == "agentcore.posture_mismatch"]
    assert mismatch, f"expected SEL agentcore.posture_mismatch row in {events!r}"
    assert mismatch[0].get("outcome") == "denied"
    assert not any("gateway" in name.lower() for name in servers)
