"""The ``memory_mode`` a fork request may ask for: the parent's, or a stricter one.

A fork child inherits its parent's memory mode (``chat_fork.fork_slot``). The
request body may name a mode, and only to TIGHTEN it: an app that owns a
persistent slot can fork it into a temporary child, so that child cannot recall
the owner's memory. A mode looser than the parent's is refused, never silently
dropped, so a caller that asked for privacy it cannot get is told so. Promotion
(``api_chat_slot_promote``) stays the one way to loosen a mode, and it discards
the body before this is read.
"""

from __future__ import annotations

from typing import Any

from aiohttp import web

from kiro_crew.dashboard.state import VALID_MEMORY_MODES
from kiro_crew.execution_context import stricter_memory_mode


def requested_fork_memory_mode(body: dict[str, Any], parent_mode: str) -> "str | web.Response":
    """The mode the body asks for, ``""`` when it names none, or the 400 refusal.

    *parent_mode* is the parent's validated mode (``resolve_fork_source`` refused
    any other before the body is read).
    """
    requested = body.get("memory_mode")
    if requested is None or requested == "":
        return ""
    if not isinstance(requested, str) or requested not in VALID_MEMORY_MODES:
        return web.json_response(
            {
                "error": f"memory_mode must be one of {list(VALID_MEMORY_MODES)}",
                "code": "invalid_memory_mode",
            },
            status=400,
        )
    if stricter_memory_mode(parent_mode, requested) != requested:
        return web.json_response(
            {
                "error": (
                    f"a fork cannot loosen the memory mode: the session is {parent_mode}, "
                    f"so its fork can be {parent_mode} or stricter"
                ),
                "code": "memory_mode_cannot_loosen",
            },
            status=400,
        )
    return requested
