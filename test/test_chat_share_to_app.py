"""Share a chat into an app — ``/api/chat/slots/{slot}/share-to-app`` and its preview.

The owner names an app; the gateway checks every row with the share privacy
filter, shows what it would hold, and on confirmation forks the chat into a slot
that app owns, born ``temporary`` whatever the parent's mode. The fork machinery
underneath is covered by the fork suites; this module tests what the share adds:
the owner gate, eligibility, the filter, the preview digest and the child's
ownership and mode. Also the fork body's ``memory_mode``, which only tightens.
"""

from __future__ import annotations

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from chat_test_helpers import _make_app, _make_state

from kiro_crew.dashboard import chat_share_app
from kiro_crew.dashboard.chat_share_privacy import held_placeholder, held_reasons
from kiro_crew.dashboard.chat_utils import effective_session_key
from kiro_crew.execution_context import read_session_execution
from kiro_crew.testing.synthetic_credentials import github_classic

APP = "crew-rooms"
TOKEN = github_classic()


@pytest.fixture(autouse=True)
def _private_sel_root_per_test(sel_private_root):
    yield


@pytest.fixture(autouse=True)
def _only_crew_rooms_is_eligible(monkeypatch):
    monkeypatch.setattr(
        chat_share_app,
        "app_token_path_allowed",
        lambda app, path: app == APP and path == chat_share_app.SHARE_TARGET_API_PATH,
    )


def _seed(tmp_path, monkeypatch, memory_mode: str | None = None, *, app: str = ""):
    monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
    state = _make_state(tmp_path)
    slot = state.get_or_create_slot("src", memory_mode=memory_mode, app=app)
    slot.append("user", "please mail anna.berg@example.org about it", "msg msg-u")
    slot.append("assistant", "Sure, drafted.", "msg msg-a", meta={"files": ["/tmp/x"]})
    slot.append("user", f"my token is {TOKEN}", "msg msg-u")
    slot.append("assistant", "Noted.", "msg msg-a")
    slot._resumed_count = len(slot.messages)
    slot._disk_window_len = len(slot.messages)
    slot._dirty = False
    return state


def _app(state, *, as_app: str = "") -> web.Application:
    app = _make_app(state)
    if as_app:

        @web.middleware
        async def _as_app(request: web.Request, handler):
            request["app"] = as_app
            request["user"] = as_app
            return await handler(request)

        app.middlewares.insert(0, _as_app)
    app.router.add_get("/api/chat/share-targets", chat_share_app.api_chat_share_targets)
    app.router.add_post(
        "/api/chat/slots/{slot}/share-to-app/preview", chat_share_app.api_chat_slot_share_preview
    )
    app.router.add_post("/api/chat/slots/{slot}/share-to-app", chat_share_app.api_chat_slot_share)
    return app


async def _post(state, path: str, payload: dict, *, as_app: str = "") -> tuple[int, dict]:
    async with TestClient(TestServer(_app(state, as_app=as_app))) as client:
        resp = await client.post(path, json=payload)
        return resp.status, await resp.json()


async def _preview(state, app: str = APP) -> tuple[int, dict]:
    return await _post(state, "/api/chat/slots/src/share-to-app/preview", {"app": app})


async def _share(state, payload: dict) -> tuple[int, dict]:
    return await _post(state, "/api/chat/slots/src/share-to-app", payload)


# ── the filter ──


def test_the_filter_holds_secrets_and_personal_data_and_names_only_reasons() -> None:
    assert held_reasons("mail anna.berg@example.org") == ("email-address",)
    assert "access-token" in held_reasons(f"use {TOKEN}")
    assert "home-directory" in held_reasons("see /home/anna/notes.md")
    assert "ip-address" in held_reasons("ssh 10.1.2.3")
    assert held_reasons("install react@18.2.0 and run the tests") == ()
    placeholder = held_placeholder(held_reasons(f"use {TOKEN}"))
    assert TOKEN not in placeholder
    assert placeholder.startswith("[held by the privacy filter: ")


# ── preview ──


@pytest.mark.asyncio
async def test_preview_lists_held_rows_and_creates_nothing(tmp_path, monkeypatch) -> None:
    state = _seed(tmp_path, monkeypatch)
    before = set(state._slots)
    status, body = await _preview(state)
    assert status == 200, body
    assert body["rows"] == 4
    assert body["memory_mode"] == "temporary"
    assert [(h["index"], h["role"]) for h in body["held"]] == [(0, "user"), (2, "user")]
    assert body["held"][0]["reasons"] == ["email-address"]
    assert "access-token" in body["held"][1]["reasons"]
    assert body["digest"]
    assert set(state._slots) == before


# ── share ──


@pytest.mark.asyncio
async def test_share_creates_a_temporary_app_owned_copy_with_held_rows_replaced(
    tmp_path, monkeypatch
) -> None:
    state = _seed(tmp_path, monkeypatch, "persistent")
    _, preview = await _preview(state)
    status, body = await _share(state, {"app": APP, "digest": preview["digest"], "release": [0]})
    assert status == 200, body
    assert body["memory_mode"] == "temporary"
    assert (body["held"], body["released"]) == (1, 1)
    child = state._slots[body["key"]]
    assert child._app == APP
    assert child.memory_mode == "temporary"
    assert child.blocks_reads and child.is_restricted
    # The bound execution record says so too, so a worker opened for it reads no memory.
    execution = read_session_execution(effective_session_key(child))
    assert execution is not None and execution.memory_mode == "temporary"
    contents = [m["content"] for m in child.messages]
    # The released row passes as written; the unreleased one is a placeholder.
    assert contents[0] == "please mail anna.berg@example.org about it"
    assert contents[2].startswith("[held by the privacy filter: ")
    assert all(TOKEN not in c for c in contents)
    # Rows carry text only: the owner's file list stays behind.
    assert "files" not in (child.messages[1].get("meta") or {})
    assert not child.pinned and not child.folder_id
    # The source is untouched.
    assert state._slots["src"].memory_mode == "persistent"
    assert len(state._slots["src"].messages) == 4


@pytest.mark.asyncio
async def test_a_chat_that_changed_since_the_preview_is_refused(tmp_path, monkeypatch) -> None:
    state = _seed(tmp_path, monkeypatch)
    _, preview = await _preview(state)
    state._slots["src"].append("user", "one more thing", "msg msg-u")
    before = set(state._slots)
    status, body = await _share(state, {"app": APP, "digest": preview["digest"]})
    assert (status, body["code"]) == (409, "share_preview_stale")
    assert set(state._slots) == before


@pytest.mark.asyncio
async def test_share_needs_the_preview_digest(tmp_path, monkeypatch) -> None:
    state = _seed(tmp_path, monkeypatch)
    status, body = await _share(state, {"app": APP})
    assert (status, body["code"]) == (400, "share_preview_required")


@pytest.mark.asyncio
async def test_release_may_only_name_held_rows(tmp_path, monkeypatch) -> None:
    state = _seed(tmp_path, monkeypatch)
    _, preview = await _preview(state)
    status, body = await _share(state, {"app": APP, "digest": preview["digest"], "release": [1]})
    assert (status, body["code"]) == (400, "share_release_not_held")


@pytest.mark.asyncio
async def test_an_ineligible_app_is_refused(tmp_path, monkeypatch) -> None:
    state = _seed(tmp_path, monkeypatch)
    status, body = await _preview(state, app="some-other-app")
    assert (status, body["code"]) == (409, "share_target_not_eligible")


@pytest.mark.asyncio
async def test_a_chat_an_app_owns_cannot_be_shared(tmp_path, monkeypatch) -> None:
    state = _seed(tmp_path, monkeypatch, app="mail-pilot")
    status, body = await _preview(state)
    assert (status, body["code"]) == (409, "share_source_owned_by_app")


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["share-to-app/preview", "share-to-app"])
async def test_an_app_credential_cannot_share(tmp_path, monkeypatch, path) -> None:
    # The owner's chat is invisible to the app: the ownership check answers first.
    state = _seed(tmp_path, monkeypatch)
    status, body = await _post(
        state, f"/api/chat/slots/src/{path}", {"app": APP, "digest": "x"}, as_app=APP
    )
    assert (status, body["code"]) == (404, "slot_not_found")
    # On its own slot it reaches the handler, which wants the owner.
    state = _seed(tmp_path, monkeypatch, app=APP)
    status, body = await _post(
        state, f"/api/chat/slots/src/{path}", {"app": APP, "digest": "x"}, as_app=APP
    )
    assert (status, body["code"]) == (403, "share_requires_dashboard_user")


@pytest.mark.asyncio
async def test_share_targets_lists_only_eligible_apps(tmp_path, monkeypatch) -> None:
    state = _seed(tmp_path, monkeypatch)
    rows = [{"name": APP, "manifest": {"displayName": "Crew Rooms"}}, {"name": "other"}]
    monkeypatch.setattr("kiro_crew.apps.manager.list_apps", lambda: rows)
    async with TestClient(TestServer(_app(state))) as client:
        resp = await client.get("/api/chat/share-targets")
        body = await resp.json()
    assert resp.status == 200, body
    assert body["apps"] == [{"name": APP, "display_name": "Crew Rooms"}]
