"""Tests for .github/scripts/fetch-security-report.sh.

The report these assertions cover is fed straight into the weekly triage
prompt, so the property under test is not "the script exits 0" but "a section
that could not be fetched never renders as a clean one".
"""

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Callable

import pytest

# Skip only OUTSIDE CI: jq is load-bearing for this script, so a CI runner
# missing it must FAIL loudly rather than silently drop the coverage.
pytestmark = pytest.mark.skipif(
    shutil.which("jq") is None and not os.environ.get("CI"),
    reason="jq not available (local run)",
)

REPO_SLUG = "acme/widgets"

# Mirrors real `gh api`: it applies `--jq` through jq but has no `--arg` (that
# is a plain-jq flag), and rejects unknown flags with a non-zero exit. Keeping
# the unknown-flag arm faithful is what makes these tests bite if `--arg` is
# ever handed back to `gh api`.
#
# Fixtures are matched by filename stem as a substring of the endpoint, so a
# test registers `dependabot` rather than the full query-string-bearing URL.
# An unregistered endpoint returns `[]`, the real "no alerts" shape.
GH_STUB = r"""#!/usr/bin/env bash
set -uo pipefail
[[ "${1:-}" == "api" ]] || { echo "stub gh: unsupported subcommand ${1:-}" >&2; exit 1; }
shift
endpoint=""
jq_expr=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --jq)
      [[ $# -ge 2 ]] || { echo "stub gh: --jq needs a value" >&2; exit 1; }
      jq_expr="$2"
      shift 2
      ;;
    --paginate)
      shift
      ;;
    -*)
      echo "unknown flag: $1" >&2
      exit 1
      ;;
    *)
      [[ -n "$endpoint" ]] || endpoint="$1"
      shift
      ;;
  esac
done

body='[]'
for fixture in "${GH_STUB_DIR}"/*; do
  [[ -e "$fixture" ]] || continue
  base="${fixture##*/}"
  case "$endpoint" in
    *"${base%.*}"*)
      if [[ "$base" == *.err ]]; then
        cat "$fixture" >&2
        exit 1
      fi
      body="$(cat "$fixture")"
      break
      ;;
  esac
done

if [[ -n "$jq_expr" ]]; then
  printf '%s' "$body" | jq -r "$jq_expr"
else
  printf '%s' "$body"
fi
"""

PNPM_STUB = """#!/usr/bin/env bash
echo "No known vulnerabilities found"
"""

DEPENDABOT_ALERT = {
    "number": 7,
    "security_advisory": {
        "severity": "critical",
        "summary": "Prototype pollution in left-pad",
    },
    "dependency": {"package": {"name": "left-pad", "ecosystem": "npm"}},
}


DEPENDABOT = "dependabot"


def _write_stub(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


def run_report(
    tmp_path: Path,
    copy_script: Callable[[str, Path], Path],
    *,
    responses: dict[str, object] | None = None,
    errors: dict[str, str] | None = None,
) -> str:
    """Run the script against a stubbed `gh`/`pnpm` and return the report text.

    `responses` maps an endpoint substring (e.g. `dependabot`) to the JSON body
    that endpoint should return; `errors` maps one to the stderr text it should
    fail with. Endpoints named in neither return `[]`.
    """
    script = copy_script("fetch-security-report.sh", tmp_path)
    bin_dir = tmp_path / "bin"
    stub_dir = tmp_path / "stubs"
    bin_dir.mkdir()
    stub_dir.mkdir()
    _write_stub(bin_dir / "gh", GH_STUB)
    _write_stub(bin_dir / "pnpm", PNPM_STUB)

    for key, body in (responses or {}).items():
        (stub_dir / f"{key}.json").write_text(json.dumps(body), encoding="utf-8")
    for key, message in (errors or {}).items():
        (stub_dir / f"{key}.err").write_text(message, encoding="utf-8")

    # package.json presence selects the pnpm-audit branch over the skip branch.
    (tmp_path / "package.json").write_text("{}", encoding="utf-8")
    report = tmp_path / "report.md"
    result = subprocess.run(
        ["bash", str(script)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "GH_STUB_DIR": str(stub_dir),
            "GH_TOKEN": "t",
            "REPO": REPO_SLUG,
            "GITHUB_ENV": str(tmp_path / "github_env"),
            "REPORT_PATH": str(report),
        },
    )
    assert result.returncode == 0, result.stderr
    return report.read_text(encoding="utf-8")


def test_alerts_render_with_repo_interpolated_into_links(
    tmp_path: Path, copy_script
) -> None:
    """The regression guard: `--arg repo` must reach a real jq process.

    Asserting on the rendered link (not merely on a non-empty section) is what
    proves the binding resolved — an unbound `$repo` makes jq abort outright.
    """
    report = run_report(
        tmp_path, copy_script, responses={DEPENDABOT: [DEPENDABOT_ALERT]}
    )
    assert "Prototype pollution in left-pad" in report
    assert f"https://github.com/{REPO_SLUG}/security/dependabot/7" in report
    assert "**CRITICAL**" in report
    assert "`left-pad` (npm)" in report
    assert "No open Dependabot alerts" not in report


def test_failed_fetch_reports_the_error_and_not_a_clean_section(
    tmp_path: Path, copy_script
) -> None:
    report = run_report(
        tmp_path,
        copy_script,
        errors={DEPENDABOT: "gh: Resource not accessible by integration (HTTP 403)"},
    )
    assert "_Could not fetch Dependabot alerts" in report
    assert "> gh: Resource not accessible by integration (HTTP 403)" in report
    # The whole point: a permissions failure must not read as "repo is clean".
    assert "No open Dependabot alerts" not in report
    # Positive marker that the run got past the failed section.
    assert "No known vulnerabilities found" in report


def test_empty_alert_list_reports_no_alerts_for_every_section(
    tmp_path: Path, copy_script
) -> None:
    # The stub returns `[]` for any endpoint with no fixture registered.
    report = run_report(tmp_path, copy_script)
    assert "_No open Dependabot alerts._" in report
    assert "_No open code scanning alerts._" in report
    assert "_No open secret scanning alerts._" in report


def test_unparseable_response_is_flagged_rather_than_swallowed(
    tmp_path: Path, copy_script
) -> None:
    # A JSON object where the jq expression expects an array: the fetch
    # succeeds, jq fails. That must not render as an empty (clean) section.
    report = run_report(tmp_path, copy_script, responses={DEPENDABOT: {"message": "x"}})
    assert "_Could not parse the API response for this section._" in report
    assert "No open Dependabot alerts" not in report


def test_oversized_error_output_is_truncated_and_says_so(
    tmp_path: Path, copy_script
) -> None:
    report = run_report(tmp_path, copy_script, errors={DEPENDABOT: "e" * 10_000})
    assert "_(error output truncated at 4000 bytes)_" in report
    # Truncated, but the surviving prefix is still quoted rather than dropped.
    assert "> " + "e" * 4000 in report
    assert "e" * 4001 not in report


def test_report_is_exported_to_github_env(tmp_path: Path, copy_script) -> None:
    run_report(tmp_path, copy_script, responses={DEPENDABOT: [DEPENDABOT_ALERT]})
    exported = (tmp_path / "github_env").read_text(encoding="utf-8")
    assert exported.startswith("SECURITY_REPORT<<REPORT_EOF_")
    assert "Prototype pollution in left-pad" in exported
