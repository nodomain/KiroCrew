"""AgentCore 3LO consent — allowlist reuse of oauth_endpoints.json."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from kiro_crew.dashboard.handlers import agentcore_consent as consent_mod
from kiro_crew.platform.defaults import DefaultAgentIdentityProvider
from kiro_crew.security import allow_agentcore_consent_url

_BUILTIN = "https://github.com/login/oauth/authorize"
_UNKNOWN = "https://evil.example/oauth/authorize"
_TOKENISH = "sltok-must-never-appear"


class _Req:
    """Owner-shaped dashboard request unless *app* / *user* are overridden."""

    def __init__(
        self,
        *,
        app: str | None = "",
        user: str = "owner-1",
        owner: str = "owner-1",
    ) -> None:
        self._store: dict[str, Any] = {"user": user}
        if app is not None:
            self._store["app"] = app
        self.app = {"state": type("S", (), {"owner_id": owner})()}

    def get(self, key: str, default: Any = None) -> Any:
        return self._store.get(key, default)

    def __contains__(self, key: object) -> bool:
        return key in self._store

    def __getitem__(self, key: str) -> Any:
        return self._store[key]


class _ConsentIdentity(DefaultAgentIdentityProvider):
    def __init__(self, url: str | None) -> None:
        self._url = url

    def enabled(self) -> bool:
        return True

    def status(self) -> dict[str, object]:
        if not self._url:
            return {}
        return {"authorizationUrl": self._url}


def test_unknown_consent_host_is_refused() -> None:
    assert allow_agentcore_consent_url(_UNKNOWN) is False


def test_builtin_consent_host_is_accepted() -> None:
    assert allow_agentcore_consent_url(_BUILTIN) is True


def test_http_and_explicit_port_are_refused() -> None:
    assert allow_agentcore_consent_url("http://github.com/login/oauth/authorize") is False
    assert allow_agentcore_consent_url("https://github.com:8443/login/oauth/authorize") is False
    assert allow_agentcore_consent_url("https://github.com:notaport/login/oauth/authorize") is False


def test_operator_extension_host_is_accepted(tmp_path: Path) -> None:
    from kiro_crew.config import loader as config_loader

    path = config_loader.oauth_endpoints_path()
    path.write_text(
        json.dumps(
            {
                "additional_authorization_endpoints": [
                    {"host": "idp.example.test", "path": "/oauth2/v1/authorize"},
                ]
            }
        ),
        encoding="utf-8",
    )
    assert allow_agentcore_consent_url("https://idp.example.test/oauth2/v1/authorize") is True
    assert allow_agentcore_consent_url("https://idp.example.test/other") is False


def test_consent_sel_logs_host_path_never_token(monkeypatch) -> None:
    from kiro_crew.platform.agentcore_gateway import surface_consent_url
    from kiro_crew.sel import sel

    monkeypatch.setattr(
        "kiro_crew.platform.agentcore_gateway.allow_agentcore_consent_url",
        lambda url: "evil.example" not in url,
    )
    assert surface_consent_url(f"{_UNKNOWN}?code={_TOKENISH}") is None
    events = [e for e in sel().recent(limit=50) if e.get("operation") == "agentcore.consent_url"]
    assert events, "expected agentcore.consent_url SEL row"
    blob = json.dumps(events)
    assert _TOKENISH not in blob
    assert "code=" not in blob
    assert events[0].get("outcome") == "denied"


def test_consent_get_unknown_host_is_403(monkeypatch) -> None:
    import dataclasses

    from kiro_crew.config import KiroCrewConfig
    from kiro_crew.platform.bootstrap import build_default_context
    from kiro_crew.platform.context import set_context
    from kiro_crew.platform.governance import parse_policy

    base = build_default_context(KiroCrewConfig())
    ceiling = parse_policy(
        {
            "version": 1,
            "boot": {"fail_closed": True},
            "capabilities": {"agentcore": {"enabled": True, "posture": "login"}},
        }
    )
    set_context(
        dataclasses.replace(
            base,
            agent_identity=_ConsentIdentity(_UNKNOWN),
            governance=ceiling,
        )
    )
    monkeypatch.setattr(consent_mod, "_audit", lambda *a, **k: None)
    resp = asyncio.run(consent_mod.api_agentcore_consent_get(_Req()))
    assert resp.status == 403
    body = json.loads(resp.text)
    assert body["code"] == "consent_host_refused"
    assert _UNKNOWN not in json.dumps(body)


def test_consent_get_allowlisted_url(monkeypatch) -> None:
    import dataclasses

    from kiro_crew.config import KiroCrewConfig
    from kiro_crew.platform.bootstrap import build_default_context
    from kiro_crew.platform.context import set_context
    from kiro_crew.platform.governance import parse_policy

    base = build_default_context(KiroCrewConfig())
    ceiling = parse_policy(
        {
            "version": 1,
            "boot": {"fail_closed": True},
            "capabilities": {"agentcore": {"enabled": True, "posture": "login"}},
        }
    )
    set_context(
        dataclasses.replace(
            base,
            agent_identity=_ConsentIdentity(_BUILTIN),
            governance=ceiling,
        )
    )
    monkeypatch.setattr(consent_mod, "_audit", lambda *a, **k: None)
    resp = asyncio.run(consent_mod.api_agentcore_consent_get(_Req()))
    assert resp.status == 200
    body = json.loads(resp.text)
    assert body["pending"] is True
    assert body["url"] == _BUILTIN


def _consent_pending(monkeypatch, url: str = _BUILTIN) -> None:
    import dataclasses

    from kiro_crew.config import KiroCrewConfig
    from kiro_crew.platform.bootstrap import build_default_context
    from kiro_crew.platform.context import set_context
    from kiro_crew.platform.governance import parse_policy

    base = build_default_context(KiroCrewConfig())
    ceiling = parse_policy(
        {
            "version": 1,
            "boot": {"fail_closed": True},
            "capabilities": {"agentcore": {"enabled": True, "posture": "login"}},
        }
    )
    set_context(
        dataclasses.replace(
            base,
            agent_identity=_ConsentIdentity(url),
            governance=ceiling,
        )
    )
    monkeypatch.setattr(consent_mod, "_audit", lambda *a, **k: None)


def test_consent_get_app_token_is_403(monkeypatch) -> None:
    _consent_pending(monkeypatch)
    resp = asyncio.run(consent_mod.api_agentcore_consent_get(_Req(app="board")))
    assert resp.status == 403
    body = json.loads(resp.text)
    assert body["code"] == "dashboard_owner_required"
    assert "url" not in body


def test_consent_get_non_owner_is_403(monkeypatch) -> None:
    _consent_pending(monkeypatch)
    resp = asyncio.run(consent_mod.api_agentcore_consent_get(_Req(user="other")))
    assert resp.status == 403
    body = json.loads(resp.text)
    assert body["code"] == "dashboard_owner_required"
    assert "url" not in body


def test_consent_get_missing_app_claim_is_403(monkeypatch) -> None:
    _consent_pending(monkeypatch)
    resp = asyncio.run(consent_mod.api_agentcore_consent_get(_Req(app=None)))
    assert resp.status == 403
    body = json.loads(resp.text)
    assert body["code"] == "dashboard_owner_required"
