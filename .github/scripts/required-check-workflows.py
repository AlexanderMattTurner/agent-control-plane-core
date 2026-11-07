"""Print the workflow files whose jobs report the given required-check contexts.

Reads one check context per line on stdin (a ruleset's required_status_checks)
and prints the basename of each workflow in WORKFLOWS_DIR that has a job whose
check-run name is one of them: the job's `name:`, or its id when it has none.
Exits 1 naming every context no job reports, because a pull request waiting on
that context can never merge.

Usage: run-with-pyyaml.sh required-check-workflows.py WORKFLOWS_DIR < contexts
"""

import sys
from pathlib import Path

import yaml


def job_check_names(workflow: Path) -> set[str]:
    """The check-run name of every job in WORKFLOW."""
    jobs = yaml.safe_load(workflow.read_text(encoding="utf-8"))["jobs"]
    return {job.get("name", job_id) for job_id, job in jobs.items()}


def main() -> None:
    workflows_dir = Path(sys.argv[1])
    contexts = {line.strip() for line in sys.stdin if line.strip()}
    workflows = sorted(workflows_dir.glob("*.y*ml"))
    if not workflows:
        sys.exit(f"no workflow files in {workflows_dir}")

    reporting: set[str] = set()
    covered: set[str] = set()
    for workflow in workflows:
        hits = job_check_names(workflow) & contexts
        if hits:
            reporting.add(workflow.name)
            covered |= hits

    missing = sorted(contexts - covered)
    if missing:
        sys.exit(
            f"no job in {workflows_dir} reports required check(s): {', '.join(missing)}"
        )
    for name in sorted(reporting):
        print(name)


if __name__ == "__main__":
    main()
