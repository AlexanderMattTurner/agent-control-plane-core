"""Guard the two test-directory contracts against silently-uncollected files.

The Node runner collects exactly `test/*.test.mjs` (no recursion); pytest
collects `tests/` (recursively). A test file dropped in the wrong directory —
or a `.test.mjs` nested under `test/fixtures/` — is run by NEITHER runner and
fails silently forever. These checks make that drop a loud CI failure.
"""

import subprocess
from pathlib import Path

REPO_ROOT = Path(
    subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
)
NODE_TEST_DIR = REPO_ROOT / "test"
PYTEST_DIR = REPO_ROOT / "tests"

# Directory entries that are tooling artifacts, not test collateral.
_IGNORED_DIRS = {"__pycache__"}


def _tracked(directory: Path) -> list[Path]:
    """Git-tracked files under `directory` (ignores caches and stray junk)."""
    out = subprocess.run(
        ["git", "ls-files", "-z", "--", str(directory)],
        capture_output=True,
        text=True,
        check=True,
        cwd=REPO_ROOT,
    ).stdout
    return [REPO_ROOT / p for p in out.split("\0") if p]


def test_node_test_dir_top_level_is_only_test_mjs() -> None:
    """Every file directly in test/ must match *.test.mjs, and some must exist."""
    top_level = [p for p in _tracked(NODE_TEST_DIR) if p.parent == NODE_TEST_DIR]
    assert top_level, "test/ must contain node test files"
    misplaced = [p for p in top_level if not p.name.endswith(".test.mjs")]
    assert misplaced == [], (
        f"files in test/ the `node --test test/*.test.mjs` glob never runs: "
        f"{[str(p.relative_to(REPO_ROOT)) for p in misplaced]}"
    )


def test_node_test_glob_misses_nothing_nested() -> None:
    """No *.test.mjs below test/'s top level — the runner glob does not recurse."""
    nested = [
        p
        for p in _tracked(NODE_TEST_DIR)
        if p.parent != NODE_TEST_DIR and p.name.endswith(".test.mjs")
    ]
    assert nested == [], (
        f"*.test.mjs files the non-recursive runner glob silently skips: "
        f"{[str(p.relative_to(REPO_ROOT)) for p in nested]}"
    )


def test_pytest_dir_is_only_python() -> None:
    """Every file under tests/ must be *.py, and some must exist."""
    files = [
        p
        for p in _tracked(PYTEST_DIR)
        if not (_IGNORED_DIRS & set(p.relative_to(PYTEST_DIR).parts[:-1]))
    ]
    assert files, "tests/ must contain pytest files"
    misplaced = [p for p in files if p.suffix != ".py"]
    assert misplaced == [], (
        f"non-Python files in tests/ that pytest never collects: "
        f"{[str(p.relative_to(REPO_ROOT)) for p in misplaced]}"
    )
