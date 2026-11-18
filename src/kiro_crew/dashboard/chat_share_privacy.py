"""The privacy check a chat transcript passes before the owner shares it into an app.

``POST /api/chat/slots/{slot}/share-to-app`` copies the owner's own chat into a
slot an app owns (:mod:`kiro_crew.dashboard.chat_share_app`). The rows can carry
what the owner never meant to hand to that app: a token pasted into a prompt, a
colleague's e-mail address, a home directory. Every row is checked here, on the
gateway, before the app can read any of it. A hit does not rewrite the row: the
row is HELD, the app's copy carries a placeholder naming the reasons, and the
owner sees the held rows in the preview and may release single rows.

The rule set is the secret and personal-data set the Crew Commons app applies on
the user's machine before anything leaves it (and that the Crew Rooms app reuses
for its own room filter). Core cannot import an app, so the rules are restated
here; on top of them the gateway's own credential pass
(:func:`kiro_crew.security.redact_with_findings`) holds anything it recognises,
so a credential shape core knows and the app rules miss is still held.

The verdict carries reason names only, never the matched text, so it is safe to
show, log and send.
"""

from __future__ import annotations

import re
from typing import NamedTuple

from kiro_crew.platform.context import redact_via_context
from kiro_crew.security import redact_with_findings

#: The reasons the gateway's own redaction passes contribute.
CREDENTIAL_REASON = "credential"
EXFILTRATION_URL_REASON = "exfiltration-url"


class _Rule(NamedTuple):
    reason: str
    pattern: re.Pattern[str]


_RULES: tuple[_Rule, ...] = (
    _Rule("private-key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    _Rule("bearer-token", re.compile(r"Bearer\s+\S+", re.IGNORECASE)),
    _Rule(
        "access-token",
        re.compile(
            r"\b(?:kbp?_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}"
            r"|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-.]+)"
        ),
    ),
    _Rule(
        "credential-assignment",
        re.compile(r"\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+", re.IGNORECASE),
    ),
    # A real top-level domain: `react@18.2.0` stays a package version, not an address.
    _Rule(
        "email-address",
        re.compile(
            r"[^@\s<>()\[\],;:\"'/]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b"
        ),
    ),
    _Rule("home-directory", re.compile(r"(?:/home|/Users)/[^/\s]+")),
    _Rule("home-directory", re.compile(r"\b[A-Z]:\\Users\\[^\\\s]+", re.IGNORECASE)),
    _Rule("ip-address", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    _Rule("long-hex", re.compile(r"\b[0-9a-fA-F]{32,}\b")),
    # Long mixed-case strings with digits look like keys; long kebab-case names do not match.
    _Rule(
        "key-like-string",
        re.compile(
            r"(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[a-z])(?=[A-Za-z0-9+_-]*[A-Z])"
            r"\b[A-Za-z0-9+_-]{40,}={0,2}"
        ),
    ),
)


def held_reasons(text: str) -> tuple[str, ...]:
    """The distinct reasons *text* is held for, in rule order; empty when it may pass.

    Fail-closed: a host that cannot compose its credential policy raises out of
    ``redact_via_context``, and the share is refused rather than checked by less.
    """
    reasons: list[str] = []
    for rule in _RULES:
        if rule.reason not in reasons and rule.pattern.search(text):
            reasons.append(rule.reason)
    _redacted, credentials, urls = redact_with_findings(text)
    if urls:
        reasons.append(EXFILTRATION_URL_REASON)
    # The active policy too, so a loaded companion's extra patterns hold a row. It
    # also rewrites exfiltration URLs, so its verdict counts only without them.
    if credentials or (not urls and redact_via_context(text) != text):
        reasons.append(CREDENTIAL_REASON)
    return tuple(reasons)


def held_placeholder(reasons: tuple[str, ...]) -> str:
    """The text an app's copy carries in place of a held row."""
    return f"[held by the privacy filter: {', '.join(reasons)}]"
