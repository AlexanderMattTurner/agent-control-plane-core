"""Print the workflow files whose jobs report the given required-check contexts.

Reads one check context per line on stdin (a ruleset's required_status_checks)
and prints the basename of each workflow in WORKFLOWS_DIR that has a job whose
check-run name is one of them: the job's `name:`, or its id when it has none.
Exits 1, printing nothing, when a context has no job reporting it or a reporting
workflow has no workflow_dispatch trigger. Either way the caller could not make
every required check report, and a pull request waiting on one never merges.

Usage: run-with-pyyaml.sh required-check-workflows.py WORKFLOWS_DIR < contexts
"""

import sys
from pathlib import Path

import yaml


def job_check_names(doc: dict) -> set[str]:
    """The check-run name of every job in a parsed workflow."""
    return {job.get("name", job_id) for job_id, job in doc["jobs"].items()}


def triggers(doc: dict) -> set[str]:
    """The event names a parsed workflow runs on (string, list, or map form)."""
    # YAML 1.1 reads the bare key `on` as boolean True.
    on = doc[True] if True in doc else doc["on"]
    return {on} if isinstance(on, str) else set(on)


def main() -> None:
    workflows_dir = Path(sys.argv[1])
    contexts = {line.strip() for line in sys.stdin if line.strip()}
    workflows = sorted(workflows_dir.glob("*.y*ml"))
    if not workflows:
        sys.exit(f"no workflow files in {workflows_dir}")

    reporting: set[str] = set()
    undispatchable: set[str] = set()
    covered: set[str] = set()
    for workflow in workflows:
        doc = yaml.safe_load(workflow.read_text(encoding="utf-8"))
        hits = job_check_names(doc) & contexts
        if not hits:
            continue
        covered |= hits
        reporting.add(workflow.name)
        if "workflow_dispatch" not in triggers(doc):
            undispatchable.add(workflow.name)

    missing = sorted(contexts - covered)
    if missing:
        sys.exit(
            f"no job in {workflows_dir} reports required check(s): {', '.join(missing)}"
        )
    if undispatchable:
        sys.exit(
            "required-check workflow(s) without a workflow_dispatch trigger: "
            + ", ".join(sorted(undispatchable))
        )
    for name in sorted(reporting):
        print(name)


if __name__ == "__main__":
    main()
