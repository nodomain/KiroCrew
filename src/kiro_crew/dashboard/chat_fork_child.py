"""Shape a fork child from its parent: what it inherits besides the transcript.

Split from :mod:`kiro_crew.dashboard.chat_fork`, which imports it from here;
:func:`kiro_crew.dashboard.chat_fork.fork_slot` is the only caller.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from kiro_crew.dashboard.chat_title import (
    _TITLE_ORIGIN_AUTO,
    _TITLE_ORIGIN_USER,
    FORK_TITLE_MARKER,
)
from kiro_crew.dashboard.chat_utils import effective_session_key
from kiro_crew.dashboard.mate_folders import inherited_folder
from kiro_crew.dashboard.slot_buffers import (
    MAX_FORK_PARENT_KEY_CHARS,
    bounded_transcript_created_at,
)
from kiro_crew.security import redact_credentials, redact_exfiltration_urls

if TYPE_CHECKING:
    from kiro_crew.dashboard.state import _ChatSlot

#: The fork direction that copies only the rows after the fork point; its child
#: is titled "Tail of". ``chat_fork`` reads it from here.
FORK_DIRECTION_TAIL = "tail"


def _shape_fork_child(
    new_slot: "_ChatSlot",
    slot: "_ChatSlot",
    *,
    direction: str,
    jev_route_allowed: bool,
    folders: list[dict[str, Any]],
    folder_principal: str,
    promote: bool = False,
) -> None:
    """Copy onto the just-minted *new_slot* what it inherits from its parent *slot*.

    *folders* is the committed folder tree and *folder_principal* the forker's
    folder principal: a parent filed in a mate's home the forker may not write
    into hands the child no folder.

    Synchronous and assignment-only. :func:`fork_slot` runs it in the
    push-suspended window that began at the mint, so the child's first
    ``slots`` frame already shows the folder, tags, color and fork title set here.
    ``promote`` titles the child as a kept copy ("Keep this chat") instead
    of a fork.
    """
    forked_from = effective_session_key(slot)
    if len(forked_from) <= MAX_FORK_PARENT_KEY_CHARS:
        new_slot.forked_from = forked_from
        new_slot.forked_from_created_at = bounded_transcript_created_at(slot._disk_meta_created_at)
    # Keep the namespace that made the parent's alias-or-template decision. The
    # execution carrier alone cannot preserve it: a template-stamped alias and
    # an alias mistakenly stored as a template id share one carrier shape on
    # disk. Saving the stamp on the child lets a later read tell them apart.
    new_slot.agent_kind = str(getattr(slot, "agent_kind", "") or "")
    new_slot.reasoning_effort = slot.reasoning_effort
    # Inherited beside the model it belongs to: the constructor takes `model` and
    # the routing choice is the other half of the same answer, so a fork of an
    # "Auto (decision model)" session that arrived pinned would run the parent's next turns
    # on a model the parent had explicitly stopped choosing by hand.
    # Inheriting is arming a SECOND routed session, so it answers to the same owner
    # predicate as the arm itself; the caller says whether it passed that predicate.
    new_slot.jev_route = slot.jev_route and jev_route_allowed
    # Inherit the active project directory so the fork keeps the parent's working
    # context (agent resolution, steering files, CWD) instead of falling back to
    # the config/workspace default on first message.
    new_slot.project = slot.project
    # Keep the app-owned agent binding with the agent it binds: the fork runs as
    # the same app agent, so the per-turn shadow check must still apply to it.
    new_slot.app_agent_owner = slot.app_agent_owner
    # Inherit the sidebar folder so the fork appears next to its parent in the UI,
    # unless it is a mate's home (or inside one) the forker may not file into.
    new_slot.folder_id = inherited_folder(folders, slot.folder_id, folder_principal)
    # Inherit tags (copied, so later edits to either slot's list stay independent).
    new_slot.tags = list(slot.tags)
    # "tags changed => revision changed": the slot was constructed with an empty
    # list under its birth revision; a snapshot of that newborn state (a slot
    # fetch racing the fork) must not share a revision with the inherited list,
    # or a delayed empty frame could become a client's next toggle base.
    new_slot.bump_tags_revision()
    # Inherit the sidebar color so the fork stays in its parent's color group;
    # either one can still be recolored on its own.
    new_slot.color_index = slot.color_index
    new_slot.color_hex = slot.color_hex
    parent_title = slot.title if slot._titled else "Untitled"
    parent_title, _ = redact_exfiltration_urls(parent_title)
    parent_title, _ = redact_credentials(parent_title)
    # Strip a leading marker from the parent so it never compounds on a
    # fork-of-a-fork.
    parent_title = parent_title.removeprefix(FORK_TITLE_MARKER)
    if promote:
        # Keep the prefix short: the sidebar row truncates, and a long
        # "Kept from private chat:" prefix fills the whole row before the
        # parent title starts, so every promoted session reads identically
        # there. "Kept:" leaves room for the title that actually distinguishes
        # them. The keep dialog carries the "from a private chat" detail.
        fork_word = "Kept:"
    elif direction == FORK_DIRECTION_TAIL:
        fork_word = "Tail of"
    else:
        fork_word = "Fork of"
    new_slot.title = f"{FORK_TITLE_MARKER}{fork_word} {parent_title}"
    new_slot._titled = True
    # The fork name is derived, not typed: it stays inside the automatic title
    # lifecycle (refreshable, and renamed from the first message the person
    # sends the child, see chat_title_fork.fork_title_pending) unless the name it
    # wraps is final. A parent with a manual name, or a legacy one, hands the
    # child a final title too. Persisted by the birth save, so a reload keeps
    # the provenance instead of treating the fork name as an untyped legacy
    # title.
    new_slot._title_origin = (
        _TITLE_ORIGIN_USER
        if slot._titled and slot._title_origin != _TITLE_ORIGIN_AUTO
        else _TITLE_ORIGIN_AUTO
    )
