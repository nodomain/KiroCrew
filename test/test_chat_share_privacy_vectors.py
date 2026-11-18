"""Shared test vectors for the share-into-app privacy filter.

The rule set in ``dashboard/chat_share_privacy.py`` restates the secret and
personal-data rules the Crew Commons app applies before anything leaves the
user's machine (``crew_commons/kb_proxy.py``), which the Crew Rooms app reuses
for its room filter (``cli/src/privacy-filter.ts``). Core cannot import an app,
so the three copies are kept in step by THIS table: same input, same held
reasons. A change to one copy's rules updates this table and the other two in
step.

The ``credential`` and ``exfiltration-url`` reasons come from the gateway's own
redaction passes and have no counterpart in the app copies; the vectors mark
which reasons are app-shared (``APP_REASONS``) so a port compares only those.

Credential-shaped inputs come from ``kiro_crew.testing.synthetic_credentials``,
never from literals.
"""

from __future__ import annotations

import pytest

from kiro_crew.dashboard import chat_share_privacy
from kiro_crew.dashboard.chat_share_privacy import held_reasons
from kiro_crew.testing.synthetic_credentials import github_classic, synth

#: Reasons all three copies produce. ``credential`` and ``exfiltration-url`` are core-only.
APP_REASONS = frozenset(
    {
        "private-key",
        "bearer-token",
        "access-token",
        "credential-assignment",
        "email-address",
        "home-directory",
        "ip-address",
        "long-hex",
        "key-like-string",
    }
)

#: (input, app-shared held reasons in rule order). Empty means the text passes.
VECTORS: list[tuple[str, tuple[str, ...]]] = [
    ("install react@18.2.0 and run the tests", ()),
    ("the build-and-deploy-pipeline-for-the-docs-site-runs-nightly", ()),
    ("see section 4.2 of the design doc", ()),
    ("-----BEGIN RSA PRIVATE KEY-----", ("private-key",)),
    ("Authorization: Bearer abc.def", ("bearer-token",)),
    # A classic GitHub token is also 40 mixed-case characters with digits.
    (f"use {github_classic()} for the push", ("access-token", "key-like-string")),
    ("password=hunter2", ("credential-assignment",)),
    ("api_key: xyz", ("credential-assignment",)),
    ("mail anna.berg@example.org about it", ("email-address",)),
    ("open /home/anna/notes.md", ("home-directory",)),
    ("open /Users/anna/notes.md", ("home-directory",)),
    (r"open C:\Users\anna\notes.md", ("home-directory",)),
    ("ssh 10.1.2.3", ("ip-address",)),
    ("commit " + "a1b2c3d4" * 4, ("long-hex",)),
    ("key " + synth(44, seed=7), ("key-like-string",)),
    (
        "mail anna.berg@example.org from /home/anna",
        ("email-address", "home-directory"),
    ),
]


@pytest.mark.parametrize("text,expected", VECTORS)
def test_the_shared_vectors_hold_the_same_reasons(text: str, expected: tuple[str, ...]) -> None:
    got = held_reasons(text)
    assert tuple(r for r in got if r in APP_REASONS) == expected
    # Anything else held is one of the core-only reasons.
    assert set(got) - APP_REASONS <= {
        chat_share_privacy.CREDENTIAL_REASON,
        chat_share_privacy.EXFILTRATION_URL_REASON,
    }


def test_every_app_reason_has_a_vector() -> None:
    covered = {r for _text, reasons in VECTORS for r in reasons}
    assert covered == APP_REASONS


def test_the_rule_table_names_exactly_the_app_reasons() -> None:
    assert {rule.reason for rule in chat_share_privacy._RULES} == APP_REASONS
