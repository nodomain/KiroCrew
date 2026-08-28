"""Tunnel integration — stub. Not available in the OSS build (see manager.py)."""

from kiro_crew.tunnel.manager import TunnelManager, TunnelState

_tunnel_public_url: str = ""
_publish_disabled: bool = False


def set_tunnel_url(url: str) -> None:
    """Called by the tunnel manager on connect/disconnect."""
    global _tunnel_public_url
    _tunnel_public_url = url


def get_tunnel_url() -> str:
    """Return the active tunnel URL, or empty string if unavailable."""
    return _tunnel_public_url


def set_publish_disabled(disabled: bool) -> None:
    """Record that this PROCESS must never publish a tunnel (``--no-tunnel``).

    Set once at gateway boot, before any service starts, and never from a
    request. It lives here — process state beside the process-global tunnel URL —
    rather than being threaded as an argument, because "this instance has no
    published surface" is a property of the process, and there is more than one
    door out: ``tunnel.setup.setup_tunnel`` starts a tunnel at boot, and the
    on-demand link path in ``slack.allowlist`` provisions one straight on the
    provider without ever constructing a manager. A parameter would have to be
    re-plumbed to each of them separately, and the next door added would ship
    unguarded by default; one predicate every door consults is what makes the
    flag a guarantee rather than a boot-path-only one.
    """
    global _publish_disabled
    _publish_disabled = disabled


def publish_disabled() -> bool:
    """True when this process was booted with ``--no-tunnel``.

    Every path that could expose a public address MUST consult this before
    starting or provisioning a tunnel. Defaults to False, so an install that
    never passes the flag behaves exactly as before.
    """
    return _publish_disabled


__all__ = [
    "TunnelManager",
    "TunnelState",
    "set_tunnel_url",
    "get_tunnel_url",
    "set_publish_disabled",
    "publish_disabled",
]
