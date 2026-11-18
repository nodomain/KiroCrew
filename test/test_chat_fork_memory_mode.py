"""A fork request's ``memory_mode`` only tightens the inherited mode.

``POST /api/chat/slots/{slot}/fork`` births the child with the parent's mode, or
with the stricter one the body names, so an app can fork a slot it owns into a
``temporary`` child that reads no memory. A looser mode is refused, never
dropped. See ``dashboard/fork_memory_mode.py``.
"""

from __future__ import annotations

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from chat_test_helpers import _make_app, _make_state

APP = "crew-rooms"


@pytest.fixture(autouse=True)
def _private_sel_root_per_test(sel_private_root):
    yield


def _seed(tmp_path, monkeypatch, memory_mode: str | None = None, *, app: str = ""):
    monkeypatch.setattr("kiro_crew.dashboard.state.config_dir", lambda: tmp_path)
    state = _make_state(tmp_path)
    slot = state.get_or_create_slot("src", memory_mode=memory_mode, app=app)
    slot.append("user", "hello", "msg msg-u")
    slot.append("assistant", "hi", "msg msg-a")
    slot._resumed_count = len(slot.messages)
    slot._disk_window_len = len(slot.messages)
    slot._dirty = False
    return state


async def _fork(state, payload: dict, *, as_app: str = "") -> tuple[int, dict]:
    app = _make_app(state)
    if as_app:

        @web.middleware
        async def _as_app(request: web.Request, handler):
            request["app"] = as_app
            request["user"] = as_app
            return await handler(request)

        app.middlewares.insert(0, _as_app)
    async with TestClient(TestServer(app)) as client:
        resp = await client.post("/api/chat/slots/src/fork", json=payload)
        return resp.status, await resp.json()


@pytest.mark.asyncio
async def test_a_fork_can_tighten_the_mode(tmp_path, monkeypatch) -> None:
    state = _seed(tmp_path, monkeypatch, "persistent")
    status, body = await _fork(state, {"memory_mode": "temporary"})
    assert status == 200, body
    assert body["memory_mode"] == "temporary"
    assert state._slots[body["key"]].memory_mode == "temporary"


@pytest.mark.asyncio
async def test_an_app_can_fork_its_own_slot_into_a_temporary_child(tmp_path, monkeypatch) -> None:
    state = _seed(tmp_path, monkeypatch, "persistent", app=APP)
    status, body = await _fork(state, {"memory_mode": "temporary"}, as_app=APP)
    assert status == 200, body
    child = state._slots[body["key"]]
    assert (child._app, child.memory_mode) == (APP, "temporary")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "parent,requested",
    [("temporary", "persistent"), ("temporary", "incognito"), ("incognito", "persistent")],
)
async def test_a_fork_cannot_loosen_the_mode(tmp_path, monkeypatch, parent, requested) -> None:
    state = _seed(tmp_path, monkeypatch, parent)
    before = set(state._slots)
    status, body = await _fork(state, {"memory_mode": requested})
    assert (status, body["code"]) == (400, "memory_mode_cannot_loosen")
    assert set(state._slots) == before


@pytest.mark.asyncio
async def test_an_unknown_fork_mode_is_refused(tmp_path, monkeypatch) -> None:
    state = _seed(tmp_path, monkeypatch)
    status, body = await _fork(state, {"memory_mode": "forever"})
    assert (status, body["code"]) == (400, "invalid_memory_mode")
