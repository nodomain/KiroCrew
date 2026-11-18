"""Share one of the owner's chats into an app: a filtered, temporary copy the app owns.

An app never reads a chat it does not own (``slot_ownership``), and that stays
true here. Instead the dashboard owner hands a chat over, naming the app:

``GET /api/chat/share-targets``
    The installed apps a chat can be shared into: enabled, with the owner-enable
    marker standing, and with ``/api/chat/slots`` approved in their
    ``permissions.api`` (an app that cannot own a chat slot has no use for one).
``POST /api/chat/slots/{slot}/share-to-app/preview``
    Body ``{app}``. Runs every row through :mod:`chat_share_privacy` and answers
    which rows would be held, with their reasons and an excerpt for the owner,
    plus a ``digest`` of exactly what was checked. Creates nothing.
``POST /api/chat/slots/{slot}/share-to-app``
    Body ``{app, digest, release?: [index, ...]}``. Refuses unless ``digest``
    still matches the transcript (``share_preview_stale``), so the share is the
    one the owner previewed. It forks the chat into a new slot the app owns, born
    ``temporary`` whatever the parent's mode, so the app's agent turns in it
    neither recall nor write the owner's memory. A held row the owner did not
    release arrives as a placeholder naming its reasons; rows carry their text
    only, no metadata.

All three are owner-only: an app credential, an unplaceable internal-secret
caller or a non-owner dashboard user is refused with 403 before anything is read.
The copy is an ordinary fork (:func:`chat_fork.fork_slot`) with the rows passed
through ``select_rows``, so it shares the fork's snapshot, save and rollback
handling. A slot an app already owns cannot be shared into another app.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import TYPE_CHECKING, Any

from aiohttp import web

from kiro_crew.dashboard.chat_fork import fork_slot, resolve_fork_source
from kiro_crew.dashboard.chat_share_privacy import held_placeholder, held_reasons
from kiro_crew.dashboard.handlers._shared_request_body import read_bounded_json
from kiro_crew.dashboard.handlers.source_providers import is_owner_dashboard_request
from kiro_crew.dashboard.slot_ownership import slot_not_found
from kiro_crew.dashboard.state import MAX_LIVE_SLOTS, DashboardState, request_slot_origin
from kiro_crew.dashboard.token_auth_app_scope import app_token_path_allowed
from kiro_crew.dashboard.token_auth_callers import folder_principal
from kiro_crew.sel import sel

if TYPE_CHECKING:
    from kiro_crew.dashboard.state import _ChatSlot

logger = logging.getLogger(__name__)

SHARE_AUDIT_OPERATION = "chat.slot_share_to_app"
PREVIEW_AUDIT_OPERATION = "chat.slot_share_to_app_preview"
#: The memory mode every shared copy is born with: the strictest one.
SHARED_MEMORY_MODE = "temporary"
#: The path an app must be allowed to reach to receive a shared chat.
SHARE_TARGET_API_PATH = "/api/chat/slots"
_MAX_APP_NAME_CHARS = 128
_MAX_RELEASE_ENTRIES = 1000
#: How much of a held row the preview shows the owner.
_EXCERPT_CHARS = 400


def _owner_refusal(request: web.Request, operation: str) -> web.Response | None:
    if is_owner_dashboard_request(request):
        return None
    sel().log_api_access(
        caller=request.get("app") or request.get("user") or "unidentified",
        operation=operation,
        outcome="denied",
        source="app_isolation",
        resources=f"slot={request.match_info.get('slot', '')}",
        error="sharing a chat into an app requires the dashboard owner",
    )
    return web.json_response(
        {
            "error": "sharing a chat into an app requires the signed-in dashboard owner",
            "code": "share_requires_dashboard_user",
        },
        status=403,
    )


async def _eligible(app_name: str) -> bool:
    return await asyncio.to_thread(app_token_path_allowed, app_name, SHARE_TARGET_API_PATH)


async def api_chat_share_targets(request: web.Request) -> web.Response:
    """GET /api/chat/share-targets — the apps the owner can share a chat into."""
    refused = _owner_refusal(request, PREVIEW_AUDIT_OPERATION)
    if refused is not None:
        return refused
    from kiro_crew.apps.manager import list_apps  # circular: apps.manager -> token_auth

    rows = await asyncio.to_thread(list_apps)
    targets: list[dict[str, str]] = []
    for row in rows:
        name = str(row.get("name") or "")
        # The eligibility read re-checks the owner-enable marker, so a disabled
        # app is left out without trusting the listing's own flag.
        if not name or not await _eligible(name):
            continue
        manifest = row.get("manifest") if isinstance(row.get("manifest"), dict) else {}
        label = manifest.get("displayName") if isinstance(manifest, dict) else None
        targets.append({"name": name, "display_name": str(label or name)})
    return web.json_response({"ok": True, "apps": targets})


async def _read_share_request(
    request: web.Request, operation: str
) -> "tuple[_ChatSlot, str, dict[str, Any]] | web.Response":
    """The owner check, the source slot and the validated target app, in that order."""
    refused = _owner_refusal(request, operation)
    if refused is not None:
        return refused
    state: DashboardState = request.app["state"]
    name = request.match_info["slot"]
    slot = state._slots.get(name)
    if slot is None:
        return slot_not_found()
    if getattr(slot, "_app", ""):
        return web.json_response(
            {
                "error": "this chat belongs to an app and cannot be shared into another one",
                "code": "share_source_owned_by_app",
            },
            status=409,
        )
    body, body_err = await read_bounded_json(request)
    if body_err is not None:
        return body_err
    assert body is not None  # read_bounded_json returns (dict, None) on success
    app_name = body.get("app")
    if not isinstance(app_name, str) or not app_name or len(app_name) > _MAX_APP_NAME_CHARS:
        return web.json_response(
            {"error": "app must name an installed app", "code": "invalid_field_type"},
            status=400,
        )
    if not await _eligible(app_name):
        sel().log_api_access(
            caller="dashboard",
            operation=operation,
            outcome="denied",
            source="dashboard",
            resources=f"slot={name},app={app_name}",
            error="target app is not enabled or may not own chat slots",
        )
        return web.json_response(
            {
                "error": (
                    "that app cannot receive a chat: it is not installed and enabled, "
                    f"or it is not allowed to use {SHARE_TARGET_API_PATH}"
                ),
                "code": "share_target_not_eligible",
            },
            status=409,
        )
    return slot, app_name, body


def _verdicts(rows: list[dict]) -> list[tuple[str, ...]]:
    return [held_reasons(str(row.get("content", "") or "")) for row in rows]


def _digest(slot_key: str, app_name: str, rows: list[dict], verdicts: list[tuple[str, ...]]) -> str:
    """What the owner previewed, so the share can prove it copies the same thing."""
    payload = [slot_key, app_name] + [
        [row.get("role", ""), row.get("content", ""), list(reasons)]
        for row, reasons in zip(rows, verdicts)
    ]
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def _fork_args(state: DashboardState, request: web.Request, app_name: str) -> dict[str, Any]:
    return {
        "at_index": None,
        "at_message_id": None,
        "direction": "head",
        "prompt": "",
        "mode_override": None,
        "request_app": app_name,
        "origin": request_slot_origin(app_name),
        "count_user_session": False,
        # The copy runs as the app's slot: it arms no routed session the
        # owner's predicate guards, and it is filed nowhere in the owner's sidebar.
        "jev_route_allowed": False,
        "folder_principal": folder_principal(state, request),
        "audit_caller": "dashboard",
        "reveal_folder": False,
        "memory_mode_floor": SHARED_MEMORY_MODE,
    }


def _app_owned_child(child: "_ChatSlot") -> None:
    """Drop the owner's sidebar placement from a copy the app now owns."""
    child.folder_id = ""
    child.pinned = False
    child.tags = []
    child.bump_tags_revision()


async def api_chat_slot_share_preview(request: web.Request) -> web.Response:
    """POST /api/chat/slots/{slot}/share-to-app/preview — what a share would hold."""
    read = await _read_share_request(request, PREVIEW_AUDIT_OPERATION)
    if isinstance(read, web.Response):
        return read
    slot, app_name, _body = read
    state: DashboardState = request.app["state"]
    source = await resolve_fork_source(
        slot, audit_caller="dashboard", audit_operation=PREVIEW_AUDIT_OPERATION
    )
    if isinstance(source, web.Response):
        return source

    def _preview(rows: list[dict]) -> web.Response:
        verdicts = _verdicts(rows)
        held = [
            {
                "index": index,
                "role": row.get("role", ""),
                "reasons": list(reasons),
                "excerpt": str(row.get("content", "") or "")[:_EXCERPT_CHARS],
            }
            for index, (row, reasons) in enumerate(zip(rows, verdicts))
            if reasons
        ]
        sel().log_api_access(
            caller="dashboard",
            operation=PREVIEW_AUDIT_OPERATION,
            outcome="allowed",
            source="dashboard",
            resources=f"slot={slot.key},app={app_name},rows={len(rows)},held={len(held)}",
        )
        return web.json_response(
            {
                "ok": True,
                "app": app_name,
                "rows": len(rows),
                "held": held,
                "memory_mode": SHARED_MEMORY_MODE,
                "digest": _digest(slot.key, app_name, rows, verdicts),
            }
        )

    result = await fork_slot(
        state,
        source,
        **_fork_args(state, request, app_name),
        audit_operation=PREVIEW_AUDIT_OPERATION,
        select_rows=_preview,
    )
    if isinstance(result, web.Response):
        return result
    # ``_preview`` always answers, so ``fork_slot`` never mints a child here.
    raise AssertionError("share preview minted a child")


def _release_set(body: dict[str, Any]) -> "set[int] | web.Response":
    raw = body.get("release", [])
    if (
        not isinstance(raw, list)
        or len(raw) > _MAX_RELEASE_ENTRIES
        or any(isinstance(i, bool) or not isinstance(i, int) or i < 0 for i in raw)
    ):
        return web.json_response(
            {
                "error": "release must be a list of held row indices from the preview",
                "code": "invalid_field_type",
            },
            status=400,
        )
    return set(raw)


async def api_chat_slot_share(request: web.Request) -> web.Response:
    """POST /api/chat/slots/{slot}/share-to-app — copy the previewed chat into the app."""
    read = await _read_share_request(request, SHARE_AUDIT_OPERATION)
    if isinstance(read, web.Response):
        return read
    slot, app_name, body = read
    state: DashboardState = request.app["state"]
    digest = body.get("digest")
    if not isinstance(digest, str) or not digest:
        return web.json_response(
            {"error": "digest from the preview is required", "code": "share_preview_required"},
            status=400,
        )
    release = _release_set(body)
    if isinstance(release, web.Response):
        return release
    if state.live_slot_count() >= MAX_LIVE_SLOTS:
        return web.json_response(
            {"error": f"slot cap reached ({MAX_LIVE_SLOTS})", "code": "slot_cap_reached"},
            status=409,
        )
    source = await resolve_fork_source(
        slot, audit_caller="dashboard", audit_operation=SHARE_AUDIT_OPERATION
    )
    if isinstance(source, web.Response):
        return source
    counts = {"held": 0, "released": 0}

    def _filtered(rows: list[dict]) -> "list[dict] | web.Response":
        verdicts = _verdicts(rows)
        if _digest(slot.key, app_name, rows, verdicts) != digest:
            return web.json_response(
                {
                    "error": "the chat changed since the preview; preview it again",
                    "code": "share_preview_stale",
                },
                status=409,
            )
        held_indices = {i for i, reasons in enumerate(verdicts) if reasons}
        if not release <= held_indices:
            return web.json_response(
                {
                    "error": "release names a row the preview did not hold",
                    "code": "share_release_not_held",
                },
                status=400,
            )
        out: list[dict] = []
        for index, (row, reasons) in enumerate(zip(rows, verdicts)):
            content = str(row.get("content", "") or "")
            if reasons and index not in release:
                content = held_placeholder(reasons)
                counts["held"] += 1
            elif reasons:
                counts["released"] += 1
            # Text only: a row's ``meta`` can name the owner's files and ids.
            out.append(
                {"role": row.get("role", "assistant"), "content": content, "ts": row.get("ts", "")}
            )
        return out

    result = await fork_slot(
        state,
        source,
        **_fork_args(state, request, app_name),
        audit_operation=SHARE_AUDIT_OPERATION,
        stamp=_app_owned_child,
        select_rows=_filtered,
    )
    if isinstance(result, web.Response):
        return result
    return web.json_response(
        {
            "ok": True,
            "key": result.slot.key,
            "app": app_name,
            "messages": result.messages,
            "memory_mode": result.slot.memory_mode,
            "held": counts["held"],
            "released": counts["released"],
        }
    )
