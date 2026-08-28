"""This-crew AgentCore identity — Settings → Security on THIS gateway.

Each crew's own dashboard shows and (when the home policy is writable)
configures ``capabilities.agentcore``. This is not a Remote Crew / launch
control: a hub launching another box is a different crew.

GET is display-only. PUT is the operator's out-of-band write of the
standalone ``security_policy.json`` home file (same trust model as
computer-use Settings: dashboard cookie, no app token). The agent tool
gate still cannot touch that path. A fleet env override or a signed
document is refused rather than rewritten.

Owner-dashboard PUT hot-applies the home file onto the running
ceiling and AWS adapter. ``restart_required`` stays true only when
that apply cannot attach the extra.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from aiohttp import web

from kiro_crew.platform.agentcore_aws import (
    ENV_GATEWAY_URL,
    apply_agentcore_runtime,
    ensure_extra,
    extra_snapshot,
    normalize_agentcore_gateway_url,
    normalize_agentcore_workload_name,
)
from kiro_crew.platform.context import PROFILE_STANDALONE, current_context
from kiro_crew.platform.governance import (
    PlatformCompositionError,
    _policy_home_path,
    agentcore_posture,
    parse_policy,
)
from kiro_crew.atomic_write import atomic_write

logger = logging.getLogger(__name__)

OP_GET = "agentcore.identity.get"
OP_SAVE = "agentcore.identity.save"
_ENV_WORKLOAD = "KIROCREW_AGENTCORE_WORKLOAD_NAME"
_POSTURES = frozenset({"none", "workload", "login"})
_MINIMAL_BOOT = {
    "require_sandbox": True,
    "allow_terminal": False,
    "fail_closed": True,
}


def _audit(
    request: web.Request,
    *,
    operation: str,
    outcome: str,
    resources: str = "",
    error: str = "",
) -> None:
    try:
        import kiro_crew.dashboard.handlers as pkg

        pkg.sel().log_api_access(
            caller=request.get("user", "dashboard"),
            operation=operation,
            outcome=outcome,
            source="dashboard",
            resources=resources,
            error=error,
        )
    except Exception:
        logger.warning("SEL logging failed for %s", operation, exc_info=True)


def _file_workload_name() -> str:
    row = _file_row()
    if row is None:
        return ""
    raw = row.get("workload_name")
    if not isinstance(raw, str) or not raw.strip():
        return ""
    try:
        return normalize_agentcore_workload_name(raw)
    except ValueError:
        return ""


def _workload_name(posture: str | None = None) -> str:
    """Policy name, else launch env. Do not invent ``kirocrew``."""
    del posture
    name = _file_workload_name()
    if name:
        return name
    return os.environ.get(_ENV_WORKLOAD, "").strip()


def _file_row() -> dict[str, Any] | None:
    """Enabled ``capabilities.agentcore`` object from the home file, if any.

    Peek only — do not parse_policy. GET must still render when the
    running ceiling is stale (boot-frozen) or the file is not yet loaded.
    """
    path = _policy_home_path()
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    caps = data.get("capabilities")
    if not isinstance(caps, dict):
        return None
    row = caps.get("agentcore")
    if not isinstance(row, dict) or not row.get("enabled"):
        return None
    return row


def _file_posture() -> str | None:
    row = _file_row()
    if row is None:
        return None
    posture = str(row.get("posture") or "").strip().lower()
    return posture if posture in {"workload", "login"} else None


def _file_gateway_url() -> str:
    row = _file_row()
    if row is None:
        return ""
    raw = row.get("gateway_url")
    if not isinstance(raw, str) or not raw.strip():
        return ""
    try:
        return normalize_agentcore_gateway_url(raw)
    except ValueError:
        return ""


def _env_gateway_url() -> str:
    raw = os.environ.get(ENV_GATEWAY_URL, "").strip()
    if not raw:
        return ""
    try:
        return normalize_agentcore_gateway_url(raw)
    except ValueError:
        return ""


def _refuse_non_owner(request: web.Request, operation: str) -> web.Response | None:
    """Refuse app tokens and non-owner dashboard sessions."""
    from kiro_crew.dashboard.handlers.source_providers import (
        is_owner_dashboard_request,
        stale_owner_session_response,
    )

    if request.get("app"):
        _audit(
            request,
            operation=operation,
            outcome="denied",
            error="app tokens may not read or write AgentCore identity",
        )
        return web.json_response(
            {"error": "dashboard user required", "code": "dashboard_user_required"},
            status=403,
        )
    if not is_owner_dashboard_request(request):
        _audit(request, operation=operation, outcome="denied", error="non_owner")
        stale = stale_owner_session_response(request)
        if stale is not None:
            return stale
        return web.json_response(
            {"error": "dashboard owner required", "code": "dashboard_owner_required"},
            status=403,
        )
    return None


def _write_reason() -> str:
    profile = getattr(current_context(), "profile", PROFILE_STANDALONE)
    if profile != PROFILE_STANDALONE:
        return "companion"
    if os.environ.get("KIROCREW_SECURITY_POLICY", "").strip():
        return "fleet_override"
    if os.environ.get("KIROCREW_POLICY_URL", "").strip():
        return "distribution"
    path = _policy_home_path()
    if not path.is_file():
        return ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "unreadable"
    if not isinstance(data, dict):
        return "unreadable"
    identity = data.get("identity")
    if isinstance(identity, dict) and str(identity.get("signature") or "").strip():
        return "signed"
    distribution = data.get("distribution")
    if isinstance(distribution, dict) and str(distribution.get("source") or "").strip():
        return "distribution"
    return ""


def _rebuild_agent_after_apply() -> None:
    """Rebuild so the next session/new sees the new Gateway spec."""
    try:
        from kiro_crew.agent import rebuild_agent_config

        rebuild_agent_config()
    except Exception:
        logger.warning("AgentCore apply: agent config rebuild failed", exc_info=True)


async def _drop_live_identity(request: web.Request) -> None:
    """Drop live ACP sessions and the process-wide SigV4 proxy after apply.

    Rebuild only affects the next ``session/new``. Existing sessions keep the
    previously injected Gateway URL and proxy/bearer headers, so Save → Off
    would otherwise leave access in place until those sessions die.
    """
    from kiro_crew.dashboard.handlers.sessions import _reset_all_sessions

    await _reset_all_sessions(request)
    try:
        from kiro_crew.platform.agentcore_sigv4 import reset_workload_proxy

        await asyncio.to_thread(reset_workload_proxy)
    except Exception:
        logger.warning("AgentCore apply: workload proxy reset failed", exc_info=True)


def _snapshot(
    *, last_extra_code: str | None = None, runtime_applied: bool = False
) -> dict[str, Any]:
    """Display the authored posture; flag when the running ceiling is stale.

    Settings configures THIS crew's home policy. PUT hot-applies the file
    onto the running ceiling; ``runtime_applied`` means that reload
    succeeded. GET never pips. ``last_extra_code`` is a just-ran
    ``ensure_extra`` result (PUT).
    """
    ceiling = getattr(current_context(), "governance", None)
    running = agentcore_posture(ceiling)
    reason = _write_reason()
    name_env = os.environ.get(_ENV_WORKLOAD, "").strip()
    if reason == "fleet_override":
        displayed = running
        source = "policy" if running else ("env" if name_env else "unset")
        restart = False
    else:
        authored = _file_posture()
        displayed = authored if authored is not None else running
        if authored is not None or running is not None:
            source = "policy"
        elif name_env:
            source = "env"
        else:
            source = "unset"
        restart = authored is not None and authored != running
        if runtime_applied:
            restart = False
    name = _workload_name(displayed)
    file_url = _file_gateway_url()
    env_url = _env_gateway_url()
    gateway_url = file_url or env_url
    payload: dict[str, Any] = {
        "configured": displayed is not None,
        "posture": displayed,
        "workload_name": name,
        "gateway_url": gateway_url,
        "source": source,
        "writable": reason == "",
        "write_blocked": reason or None,
        "restart_required": restart,
    }
    payload.update(extra_snapshot(last_code=last_extra_code))
    return payload


def _read_home_document() -> dict[str, Any]:
    path = _policy_home_path()
    if not path.is_file():
        return {"version": 1, "boot": dict(_MINIMAL_BOOT), "capabilities": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PlatformCompositionError(f"security policy is unreadable: {exc}") from exc
    if not isinstance(data, dict):
        raise PlatformCompositionError("security policy top level is not an object")
    return data


def _write_home_document(data: dict[str, Any]) -> None:
    parse_policy(data)
    path = _policy_home_path()
    # atomic_write refuses a linked parent before mkdir; do not mkdir first.
    payload = json.dumps(data, indent=2, sort_keys=False) + "\n"
    atomic_write(path, payload, restrict_to_owner=True)


def _apply_posture(
    data: dict[str, Any],
    posture: str,
    *,
    gateway_url: str | None = None,
    workload_name: str | None = None,
) -> dict[str, Any]:
    caps = data.get("capabilities")
    if not isinstance(caps, dict):
        caps = {}
        data["capabilities"] = caps
    previous = caps.get("agentcore")
    if posture == "none":
        if isinstance(previous, dict):
            kept = {
                key: value for key, value in previous.items() if key not in {"enabled", "posture"}
            }
            kept["enabled"] = False
            caps["agentcore"] = kept
        return data
    existing_url = ""
    existing_name = ""
    row: dict[str, Any] = {}
    if isinstance(previous, dict):
        row = {
            key: value
            for key, value in previous.items()
            if key not in {"enabled", "posture", "gateway_url", "workload_name"}
        }
        if isinstance(previous.get("gateway_url"), str):
            existing_url = previous["gateway_url"].strip()
        if isinstance(previous.get("workload_name"), str):
            existing_name = previous["workload_name"].strip()
    row["enabled"] = True
    row["posture"] = posture
    chosen_url = existing_url if gateway_url is None else gateway_url
    if chosen_url:
        row["gateway_url"] = chosen_url
    chosen_name = existing_name if workload_name is None else workload_name
    if chosen_name:
        row["workload_name"] = chosen_name
    caps["agentcore"] = row
    if "boot" not in data or not isinstance(data.get("boot"), dict):
        data["boot"] = dict(_MINIMAL_BOOT)
    return data


def _persist_identity_write(
    posture: str,
    *,
    gateway_url: str | None,
    workload_name: str | None,
) -> dict[str, Any] | None:
    """Write the home file. Return a snapshot when none-without-file is a no-op."""
    path = _policy_home_path()
    if posture == "none" and not path.is_file():
        return _snapshot()
    data = _read_home_document()
    _apply_posture(data, posture, gateway_url=gateway_url, workload_name=workload_name)
    _write_home_document(data)
    return None


def _unavailable_snapshot() -> dict[str, Any]:
    fallback: dict[str, Any] = {
        "configured": False,
        "posture": None,
        "workload_name": _workload_name(),
        "gateway_url": "",
        "source": "unset",
        "writable": False,
        "write_blocked": "unavailable",
        "restart_required": False,
    }
    fallback.update(extra_snapshot())
    return fallback


async def api_agentcore_identity_get(request: web.Request) -> web.Response:
    """GET /api/agentcore/identity — this crew's AgentCore identity (read)."""
    refused = _refuse_non_owner(request, OP_GET)
    if refused is not None:
        return refused
    try:
        payload = await asyncio.to_thread(_snapshot)
    except Exception:
        logger.warning("agentcore identity snapshot failed", exc_info=True)
        _audit(request, operation=OP_GET, outcome="error", error="snapshot_failed")
        fallback = await asyncio.to_thread(_unavailable_snapshot)
        return web.json_response(fallback)
    _audit(request, operation=OP_GET, outcome="success")
    return web.json_response(payload)


async def api_agentcore_identity_save(request: web.Request) -> web.Response:
    """PUT /api/agentcore/identity — set this crew's AgentCore posture.

    Owner dashboard cookie only — same gate as consent GET. App tokens and
    allow-listed messaging users are refused before the body is read: this
    writes the keystone the agent cannot touch.
    """
    refused = _refuse_non_owner(request, OP_SAVE)
    if refused is not None:
        return refused
    try:
        body = await request.json()
    except Exception:
        _audit(request, operation=OP_SAVE, outcome="denied", resources="invalid_json")
        return web.json_response({"error": "invalid JSON", "code": "invalid_json"}, status=400)
    if not isinstance(body, dict):
        _audit(request, operation=OP_SAVE, outcome="denied", resources="body_not_object")
        return web.json_response(
            {"error": "request body must be a JSON object", "code": "invalid_json"},
            status=400,
        )
    raw = body.get("posture")
    if not isinstance(raw, str) or raw.strip().lower() not in _POSTURES:
        _audit(request, operation=OP_SAVE, outcome="denied", resources="bad_posture")
        return web.json_response(
            {
                "error": "posture must be none, workload, or login",
                "code": "invalid_agentcore_posture",
            },
            status=400,
        )
    posture = raw.strip().lower()
    workload_name: str | None = None
    if "workload_name" in body:
        raw_name = body.get("workload_name")
        if raw_name is None:
            workload_name = ""
        elif not isinstance(raw_name, str):
            _audit(request, operation=OP_SAVE, outcome="denied", resources="bad_workload_name")
            return web.json_response(
                {
                    "error": "workload_name must be a workload identity name or empty",
                    "code": "invalid_agentcore_workload_name",
                },
                status=400,
            )
        else:
            try:
                workload_name = normalize_agentcore_workload_name(raw_name)
            except ValueError:
                _audit(request, operation=OP_SAVE, outcome="denied", resources="bad_workload_name")
                return web.json_response(
                    {
                        "error": "workload_name must be 3–255 letters, digits, _ . or -",
                        "code": "invalid_agentcore_workload_name",
                    },
                    status=400,
                )
    gateway_url: str | None = None
    if "gateway_url" in body:
        raw_url = body.get("gateway_url")
        if raw_url is None:
            gateway_url = ""
        elif not isinstance(raw_url, str):
            _audit(request, operation=OP_SAVE, outcome="denied", resources="bad_gateway_url")
            return web.json_response(
                {
                    "error": "gateway_url must be an https URL or empty",
                    "code": "invalid_agentcore_gateway_url",
                },
                status=400,
            )
        else:
            try:
                gateway_url = normalize_agentcore_gateway_url(raw_url)
            except ValueError:
                _audit(request, operation=OP_SAVE, outcome="denied", resources="bad_gateway_url")
                return web.json_response(
                    {
                        "error": "gateway_url must be an https URL without credentials",
                        "code": "invalid_agentcore_gateway_url",
                    },
                    status=400,
                )
    blocked = _write_reason()
    if blocked:
        _audit(
            request,
            operation=OP_SAVE,
            outcome="denied",
            resources=blocked,
            error="policy not writable from this gateway",
        )
        return web.json_response(
            {
                "error": "this crew's security policy cannot be edited here",
                "code": "policy_not_writable",
                "write_blocked": blocked,
            },
            status=409,
        )
    if posture in {"workload", "login"}:
        existing_name = ""
        row = _file_row()
        if row is not None and isinstance(row.get("workload_name"), str):
            existing_name = str(row.get("workload_name") or "").strip()
        chosen_name = existing_name if workload_name is None else workload_name
        if not chosen_name:
            _audit(request, operation=OP_SAVE, outcome="denied", resources="workload_name_required")
            return web.json_response(
                {
                    "error": "workload_name is required when identity is on",
                    "code": "workload_name_required",
                },
                status=400,
            )
    try:
        noop = await asyncio.to_thread(
            _persist_identity_write,
            posture,
            gateway_url=gateway_url,
            workload_name=workload_name,
        )
        if noop is not None:
            _audit(request, operation=OP_SAVE, outcome="success", resources="none")
            return web.json_response(noop)
    except PlatformCompositionError as exc:
        _audit(request, operation=OP_SAVE, outcome="denied", error=str(exc))
        return web.json_response({"error": str(exc), "code": "invalid_policy"}, status=400)
    except OSError as exc:
        logger.warning("agentcore identity write failed", exc_info=True)
        _audit(request, operation=OP_SAVE, outcome="error", error=str(exc))
        return web.json_response(
            {"error": "could not write security policy", "code": "write_failed"},
            status=500,
        )
    extra_code = None
    if posture in {"workload", "login"}:
        extra_code = await asyncio.to_thread(ensure_extra)
    applied = await asyncio.to_thread(apply_agentcore_runtime)
    if applied:
        await asyncio.to_thread(_rebuild_agent_after_apply)
        await _drop_live_identity(request)
    payload = await asyncio.to_thread(
        _snapshot, last_extra_code=extra_code, runtime_applied=applied
    )
    _audit(request, operation=OP_SAVE, outcome="success", resources=posture)
    return web.json_response(payload)
