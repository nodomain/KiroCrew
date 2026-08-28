"""Repo-wide ratchets for reusable-workflow secret scope and publish-lane caches.

Both invariants were established one workflow at a time (`publish-windows.yml`
got explicit secrets first; `release.yml` and the three build lanes got
`enable-cache: false` first). A per-file assertion protects only the files that
already tripped the audit, so the NEXT lane added silently reopens the hole.
These tests derive the file set from the workflow graph instead, so a new caller
or a new publish lane is covered the moment it is committed.

Scope note: these are deliberately structural, not `zizmor` re-runs. zizmor
cannot see through `workflow_call`, which is exactly why the cache invariant
below needed finding by hand -- cache sites were live on publish lanes that
zizmor never reported.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"

# The two entry points that publish. Everything reachable from them by
# `uses: ./.github/workflows/...` builds, signs, gates or ships released bytes.
PUBLISH_ENTRY_POINTS = ("nightly.yml", "release.yml")

# Always present, never declared as a workflow_call secret.
IMPLICIT_SECRETS = frozenset({"GITHUB_TOKEN"})

LOCAL_USES_RE = re.compile(r"\./\.github/workflows/([A-Za-z0-9._-]+\.ya?ml)$")
SECRET_REF_RE = re.compile(r"secrets\.([A-Za-z_][A-Za-z0-9_]*)")


def _load(name: str) -> dict[str, Any]:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def _triggers(workflow: dict[str, Any]) -> dict[str, Any]:
    """PyYAML resolves the bare key `on` to the boolean True (YAML 1.1), so the
    trigger block is not reachable under the string "on"."""
    block = workflow[True] if True in workflow else workflow.get("on")
    return block if isinstance(block, dict) else {}


def _local_callers() -> list[tuple[str, str, dict[str, Any]]]:
    """Every (caller, callee, job) triple that calls a workflow in this repo."""
    found: list[tuple[str, str, dict[str, Any]]] = []
    for path in sorted(WORKFLOWS.glob("*.yml")):
        workflow = _load(path.name)
        for job in (workflow.get("jobs") or {}).values():
            if not isinstance(job, dict):
                continue
            match = LOCAL_USES_RE.match(str(job.get("uses", "")))
            if match:
                found.append((path.name, match.group(1), job))
    return found


def _reachable_publish_lanes() -> set[str]:
    """Transitive closure of local `uses:` from the publishing entry points."""
    seen: set[str] = set()
    queue = list(PUBLISH_ENTRY_POINTS)
    edges = [(caller, callee) for caller, callee, _ in _local_callers()]
    while queue:
        current = queue.pop()
        if current in seen:
            continue
        seen.add(current)
        queue.extend(callee for caller, callee in edges if caller == current)
    return seen


def _callees() -> list[str]:
    return sorted({callee for _, callee, _ in _local_callers()})


def _declared_secrets(callee: str) -> dict[str, Any]:
    call = _triggers(_load(callee)).get("workflow_call")
    if not isinstance(call, dict):
        return {}
    return call.get("secrets") or {}


def _referenced_secrets(callee: str) -> set[str]:
    text = (WORKFLOWS / callee).read_text(encoding="utf-8")
    return set(SECRET_REF_RE.findall(text)) - IMPLICIT_SECRETS


class TestReusableWorkflowSecretScope:
    def test_no_caller_inherits_the_whole_secret_store(self) -> None:
        """`secrets: inherit` hands a called workflow EVERY repository secret.

        Asserted over every local call site rather than the lanes that happened
        to be audited, so adding a caller cannot reintroduce it unnoticed."""
        offenders = [
            f"{caller} -> {callee}"
            for caller, callee, job in _local_callers()
            if job.get("secrets") == "inherit"
        ]
        assert not offenders, "these call sites inherit every repository secret: " + ", ".join(
            sorted(offenders)
        )

    def test_every_passed_secret_is_declared_by_the_callee(self) -> None:
        """A secret passed but not declared is silently dropped, so the callee
        sees an empty value and skips work it was supposed to do -- the failure
        looks like a missing credential, not a typo in the caller."""
        problems: list[str] = []
        for caller, callee, job in _local_callers():
            passed = job.get("secrets")
            if not isinstance(passed, dict):
                continue
            declared = _declared_secrets(callee)
            for name in passed:
                if name not in declared:
                    problems.append(f"{caller} passes {name} to {callee}, undeclared")
        assert not problems, "; ".join(problems)

    def test_every_secret_a_callee_reads_is_declared(self) -> None:
        """The mirror of the test above. A reusable workflow that READS a secret
        it never declares only works while some caller says `secrets: inherit`;
        converting that caller to an explicit list then breaks the lane at
        runtime. Declaring the full read set is what makes the conversion safe."""
        problems: list[str] = []
        for callee in _callees():
            call = _triggers(_load(callee)).get("workflow_call")
            if not isinstance(call, dict):
                continue
            declared = set(_declared_secrets(callee))
            for name in sorted(_referenced_secrets(callee) - declared):
                problems.append(f"{callee} reads {name} without declaring it")
        assert not problems, "; ".join(problems)

    def test_declared_secrets_stay_optional(self) -> None:
        """Every one of these lanes has a no-credential path -- a fork, or the
        `workflow_dispatch` packaging probe -- that must still run and skip the
        signing steps. `required: true` turns that clean skip into a
        workflow-call failure before the job starts."""
        problems: list[str] = []
        for callee in _callees():
            for name, spec in _declared_secrets(callee).items():
                if isinstance(spec, dict) and spec.get("required") is True:
                    problems.append(f"{callee}:{name}")
        assert not problems, (
            "these declarations are required:true, which breaks the "
            "no-credential path: " + ", ".join(problems)
        )


def _cache_offenders(name: str) -> list[str]:
    """Enabled caches in one workflow, as human-readable step descriptions."""
    workflow = _load(name)
    offenders: list[str] = []
    for job_name, job in (workflow.get("jobs") or {}).items():
        if not isinstance(job, dict):
            continue
        for step in job.get("steps") or []:
            if not isinstance(step, dict):
                continue
            uses = str(step.get("uses", ""))
            with_block = step.get("with") or {}
            if uses.startswith("actions/cache@"):
                offenders.append(f"{name}:{job_name} uses actions/cache")
            elif uses.startswith("actions/setup-node@"):
                if with_block.get("cache"):
                    offenders.append(f"{name}:{job_name} setup-node cache is on")
            elif uses.startswith("astral-sh/setup-uv@"):
                # `enable-cache` defaults to `auto`, which is ON for a hosted
                # runner in a uv-managed project. Omitting the key is not
                # neutral, so an explicit false is required.
                if with_block.get("enable-cache") is not False:
                    offenders.append(f"{name}:{job_name} setup-uv does not set enable-cache: false")
    return offenders


class TestPublishLaneCaches:
    def test_the_publish_graph_is_discovered_not_hardcoded(self) -> None:
        """Guards the test below: if the traversal silently stopped matching (a
        renamed entry point, a changed `uses:` spelling) it would pass by
        inspecting nothing."""
        lanes = _reachable_publish_lanes()
        assert set(PUBLISH_ENTRY_POINTS) <= lanes
        # The build + sign lanes are the ones whose bytes reach users; if the
        # traversal cannot see them it is not traversing.
        assert {
            "build-wheel.yml",
            "build-desktop.yml",
            "build-windows.yml",
            "sign-and-notarize.yml",
            "publish-cli.yml",
        } <= lanes

    @pytest.mark.parametrize("name", sorted(_reachable_publish_lanes()))
    def test_publish_lane_has_no_enabled_cache(self, name: str) -> None:
        """An Actions cache is writable from any branch and readable by a tag
        run, so on a lane that builds, signs, gates or ships released bytes a
        restored entry is an input a lower-trust context can influence.

        This includes the gates: `dependency-vulnerability.yml` decides whether
        a release proceeds by reading the dependency tree, and a gate that can
        be handed its own answer is not a gate."""
        offenders = _cache_offenders(name)
        assert not offenders, "; ".join(offenders)
