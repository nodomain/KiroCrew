"""The backend mounts its three routes on the gateway aiohttp app."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from aiohttp import web

from kiro_crew.apps.builtins.design_critique import register_routes
from kiro_crew.apps.builtins.design_critique.backend import routes


def test_register_routes_mounts_the_three_endpoints() -> None:
    app = web.Application()
    register_routes(app)
    mounted = {
        (r.method, r.resource.canonical) for r in app.router.routes() if r.resource is not None
    }
    assert ("GET", "/api/apps/design-critique/method") in mounted
    assert ("POST", "/api/apps/design-critique/discover") in mounted
    assert ("POST", "/api/apps/design-critique/render") in mounted


def test_only_http_urls_are_renderable() -> None:
    assert routes._is_http_url("https://example.com")
    assert routes._is_http_url("http://localhost:3000")
    # A file:// URL would turn the renderer into a local-file read primitive.
    assert not routes._is_http_url("file:///etc/passwd")
    assert not routes._is_http_url("ftp://host/x")


def test_read_capped_truncates_and_flags_overflow() -> None:
    async def go() -> tuple[bytes, bool]:
        reader = asyncio.StreamReader()
        reader.feed_data(b"x" * 100)
        reader.feed_eof()
        return await routes._read_capped(reader, 10)

    data, over = asyncio.run(go())
    assert over is True
    assert len(data) == 10


def test_read_capped_small_output_not_flagged() -> None:
    async def go() -> tuple[bytes, bool]:
        reader = asyncio.StreamReader()
        reader.feed_data(b"hello")
        reader.feed_eof()
        return await routes._read_capped(reader, 1024)

    data, over = asyncio.run(go())
    assert over is False
    assert data == b"hello"


def test_resolve_vetted_returns_ips_and_blocks_internal() -> None:
    run = asyncio.run
    # Loopback is allowed for url-preview and the vetted IP is returned for pinning.
    assert "127.0.0.1" in (run(routes._resolve_vetted("http://127.0.0.1:3000/")) or [])
    # A clone (allow_loopback=False) refuses loopback; internal ranges refused too.
    assert run(routes._resolve_vetted("http://127.0.0.1/", allow_loopback=False)) is None
    assert run(routes._resolve_vetted("http://10.0.0.5/")) is None
    # Carrier-grade NAT is not is_private but must still be refused.
    assert run(routes._resolve_vetted("http://100.64.0.5/")) is None
    # Deprecated IPv6 site-local (fec0::/10) reports is_global True but is
    # internal — the allowlist invariant must still refuse it.
    assert run(routes._resolve_vetted("http://[fec0::1]/")) is None
    # A genuinely global IPv6 host is allowed.
    assert run(routes._resolve_vetted("http://[2606:2800:220:1:248:1893:25c8:1946]/")) is not None


def test_resolve_vetted_loopback_only_for_typed_loopback(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    run = asyncio.run

    def fake_gai(host, port, *a, **k):  # type: ignore[no-untyped-def]
        return [(2, 1, 6, "", ("127.0.0.1", port))]

    monkeypatch.setattr(routes.socket, "getaddrinfo", fake_gai)
    # A TYPED loopback host is allowed (the localhost preview).
    assert run(routes._resolve_vetted("http://localhost:3000/")) == ["127.0.0.1"]
    # An arbitrary hostname that merely RESOLVES to loopback is refused, so an
    # attacker name cannot front a localhost service.
    assert run(routes._resolve_vetted("http://evil.example/")) is None


def test_sweep_removes_probe_and_clones_keeps_render(monkeypatch, tmp_path) -> None:  # type: ignore[no-untyped-def]
    import time

    monkeypatch.setattr(routes, "_uploads_dir", lambda: tmp_path)
    aged = time.time() - routes._CLONE_TTL_SEC - 60
    for name in ("dc-probe-old", "dc-clones/repo-old", "dc-render-old"):
        d = tmp_path / name
        d.mkdir(parents=True, exist_ok=True)
        os.utime(d, (aged, aged))
    routes._sweep_clones()
    assert not (tmp_path / "dc-probe-old").exists()
    assert not (tmp_path / "dc-clones" / "repo-old").exists()
    # dc-render-* is referenced by saved critique history — must NOT be swept.
    assert (tmp_path / "dc-render-old").exists()


def test_malformed_ipv6_url_refused_not_crash() -> None:
    # A bad IPv6 authority makes urlparse raise ValueError; the guard must refuse
    # (return False) rather than let the exception crash discovery.
    for bad in ("http://[::1", "http://[gggg::]/", "http://[::1]:notaport/"):
        assert asyncio.run(routes._url_target_allowed(bad)) is False


def test_clone_rejects_loopback_url() -> None:
    # A repo clone has no localhost-preview use, so loopback is refused there.
    ok = asyncio.run(
        routes._url_target_allowed("http://127.0.0.1:8080/repo.git", allow_loopback=False)
    )
    assert ok is False


def test_url_allows_loopback_for_preview() -> None:
    ok = asyncio.run(routes._url_target_allowed("http://127.0.0.1:5173/", allow_loopback=True))
    assert ok is True


def test_script_env_pins_path_and_disables_git_prompt() -> None:
    env = routes._script_env()
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    node = routes._tool("node")
    if node:
        # PATH is pinned to the resolved toolchain dir, not the ambient PATH.
        assert os.path.dirname(node) in env["PATH"].split(os.pathsep)


def test_credential_dirs_are_refused() -> None:
    assert routes._is_sensitive_dir(Path.home() / ".ssh")
    # Plain credential dot-dirs the is_sensitive_path floor does not enumerate.
    assert routes._is_sensitive_dir(Path.home() / ".gnupg")
    assert routes._is_sensitive_dir(Path("/Users/x/.docker/buildx"))
    # A normal project folder is not refused (intended product behaviour).
    assert not routes._is_sensitive_dir(Path("/Users/x/Developer/myapp"))


class _Req:
    """Minimal stand-in exposing the one method the handler awaits."""

    def __init__(self, payload: object) -> None:
        self._payload = payload

    async def json(self) -> object:
        return self._payload


def test_render_rejects_non_object_picks() -> None:
    # {"picks": [null]} must not reach .get() on a non-dict and 500.
    resp = asyncio.run(
        routes._handle_render(_Req({"kind": "local", "value": "/tmp", "picks": [None]}))  # type: ignore[arg-type]
    )
    assert resp.status == 400


def test_render_rejects_overlong_field(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    # An overlong ref would raise OSError at the filesystem/exec layer (HTTP 500);
    # the handler must refuse it with 400 up front.
    monkeypatch.setattr(routes, "_node", lambda: "/usr/bin/node")
    resp = asyncio.run(
        routes._handle_render(
            _Req(
                {
                    "kind": "url",
                    "value": "https://example.com",
                    "picks": [{"ref": "/" + "a" * 5000, "label": "x"}],
                }
            )  # type: ignore[arg-type]
        )
    )
    assert resp.status == 400
    assert isinstance(resp.body, bytes) and b"field_too_long" in resp.body


def test_render_rejects_too_many_picks(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(routes, "_node", lambda: "/usr/bin/node")
    resp = asyncio.run(
        routes._handle_render(
            _Req(
                {
                    "kind": "url",
                    "value": "https://example.com",
                    "picks": [{"ref": "/", "label": "x"}] * (routes._MAX_PICKS + 1),
                }
            )  # type: ignore[arg-type]
        )
    )
    assert resp.status == 400
    assert isinstance(resp.body, bytes) and b"too_many_picks" in resp.body


def test_render_rejects_nul_in_ref(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    # A NUL in a posted ref would make create_subprocess_exec raise ValueError
    # (HTTP 500); the handler must refuse it up front with 400.
    monkeypatch.setattr(routes, "_node", lambda: "/usr/bin/node")
    resp = asyncio.run(
        routes._handle_render(
            _Req(
                {
                    "kind": "url",
                    "value": "https://example.com",
                    "picks": [{"ref": "/\x00", "label": "x"}],
                }
            )  # type: ignore[arg-type]
        )
    )
    assert resp.status == 400
    assert isinstance(resp.body, bytes) and b"bad_ref" in resp.body


def test_render_rejects_repo_handle_escape(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    # A crafted "../.." handle must not let render escape the clones dir.
    monkeypatch.setattr(routes, "_node", lambda: "/usr/bin/node")
    resp = asyncio.run(
        routes._handle_render(
            _Req({"kind": "repo", "handle": "../../etc", "picks": [{"id": "a", "label": "A"}]})  # type: ignore[arg-type]
        )
    )
    assert resp.status == 400
    assert isinstance(resp.body, bytes) and b"bad_handle" in resp.body


def test_url_target_allows_loopback_blocks_internal() -> None:
    # Loopback is the advertised localhost-preview target; internal ranges and the
    # cloud-metadata endpoint are blocked; public and file:// are handled too.
    run = asyncio.run
    assert run(routes._url_target_allowed("http://127.0.0.1:3000/"))
    assert run(routes._url_target_allowed("https://93.184.216.34/"))
    assert not run(routes._url_target_allowed("http://169.254.169.254/"))
    assert not run(routes._url_target_allowed("http://10.0.0.5/"))
    assert not run(routes._url_target_allowed("file:///etc/passwd"))
    # A malformed authority (bad port) must be refused, not raise.
    assert not run(routes._url_target_allowed("http://host:notaport/"))


def test_discover_repo_rejects_non_http_url() -> None:
    # The git remote-helper RCE vector (`ext::sh -c …`) is refused before git runs.
    resp = asyncio.run(
        routes._handle_discover(_Req({"kind": "repo", "value": "ext::sh -c id"}))  # type: ignore[arg-type]
    )
    assert resp.status == 200
    assert isinstance(resp.body, bytes) and b"no-access" in resp.body
