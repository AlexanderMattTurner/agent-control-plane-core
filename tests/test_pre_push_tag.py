"""The pre-push hook against real tag pushes, with pre-commit absent.

`auto-version.yaml` publishes to npm and then pushes `v<version>` from a runner
that never installs pre-commit. The hook demanded the tool before it knew
whether the push carried any commits, so it refused a tag on a commit the remote
already had: 0.2.15 and 0.2.16 reached npm with no tag behind them, and every
later run re-analyzed the same commits.

Driven through real `git` against a real bare remote — the hook's whole job is
to read what git feeds it on stdin, which no stub reproduces.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

from ._helpers import REPO_ROOT, commit_all, git_env, init_test_repo


def _toolless_env(home: Path) -> dict[str, str]:
    """git on PATH and nothing else. The hook prepends `$HOME/.local/bin` and
    `$HOME/.cargo/bin`, so HOME must move too or the session's own uvx leaks in
    and the tool check never fires."""
    git = shutil.which("git")
    assert git, "no git on PATH — every case below would be vacuous"
    path = str(Path(git).parent)
    # A machine with a system-wide pre-commit would let the positive case pass
    # without the fix and turn the control below green for the wrong reason.
    for tool in ("uvx", "pre-commit"):
        assert shutil.which(tool, path=path) is None, (
            f"{tool} resolves under {path}; this fixture cannot make the tool absent"
        )
    return {**git_env(), "HOME": str(home), "PATH": path}


@pytest.fixture
def repo_with_hook(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    """A repo with a real bare remote, the real `pre-push` hook installed, and
    one commit already pushed to main."""
    remote = tmp_path / "remote.git"
    subprocess.run(
        ["git", "init", "-q", "--bare", "-b", "main", str(remote)], check=True
    )

    local = tmp_path / "local"
    init_test_repo(local)
    subprocess.run(
        ["git", "remote", "add", "origin", str(remote)], cwd=local, check=True
    )

    # Seed main with the hook disabled: the first push is fixture setup, not the
    # behavior under test, and `init_test_repo` points core.hooksPath at /dev/null
    # so a scratch repo can commit without the real commit-msg/commitlint config.
    (local / "a.txt").write_text("one\n", encoding="utf-8")
    commit_all(local, "feat: one")
    subprocess.run(["git", "push", "-q", "origin", "main"], cwd=local, check=True)

    # Install only the hook under test and the helper it sources, so nothing else
    # in .hooks/ can decide the outcome.
    hooks = local / ".hooks"
    hooks.mkdir()
    for name in ("pre-push", "lib-gate.sh"):
        shutil.copy2(REPO_ROOT / ".hooks" / name, hooks / name)
    (hooks / "pre-push").chmod(0o755)
    subprocess.run(
        ["git", "config", "--local", "core.hooksPath", ".hooks"],
        cwd=local,
        check=True,
    )
    return local, remote, _toolless_env(tmp_path / "home")


def _push(repo: Path, env: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "push", "origin", *args],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
    )


def _remote_tags(remote: Path) -> list[str]:
    out = subprocess.run(
        ["git", "tag", "--list"], cwd=remote, capture_output=True, text=True, check=True
    )
    return out.stdout.split()


@pytest.mark.parametrize("annotated", [False, True], ids=["lightweight", "annotated"])
def test_a_tag_on_a_pushed_commit_needs_no_pre_commit(
    repo_with_hook: tuple[Path, Path, dict[str, str]], annotated: bool
) -> None:
    """Both tag shapes, because an annotated tag pushes the tag OBJECT's sha:
    comparing that against the range base can never match, which is the exact
    reading that made the hook refuse a release tag."""
    local, remote, env = repo_with_hook
    tag = "v9.9.9"
    make = (
        ["git", "tag", tag] if not annotated else ["git", "tag", "-a", tag, "-m", tag]
    )
    subprocess.run(make, cwd=local, env=git_env(), check=True)

    result = _push(local, env, tag)

    assert result.returncode == 0, (
        f"pre-push refused a tag on an already-pushed commit: {result.stderr}"
    )
    assert _remote_tags(remote) == [tag]


def test_a_tag_carrying_unpushed_commits_still_fails_closed(
    repo_with_hook: tuple[Path, Path, dict[str, str]],
) -> None:
    """The control for the case above. A tag can drag new commits to the remote,
    so skipping every tag would be a hole; only an EMPTY range may skip the
    tool."""
    local, remote, env = repo_with_hook
    (local / "b.txt").write_text("two\n", encoding="utf-8")
    commit_all(local, "feat: two")
    subprocess.run(["git", "tag", "v9.9.10"], cwd=local, env=git_env(), check=True)

    result = _push(local, env, "v9.9.10")

    assert result.returncode != 0, "a tag carrying new commits skipped the tool check"
    assert "required tool 'pre-commit' not found" in result.stderr
    assert _remote_tags(remote) == [], "the refused tag reached the remote anyway"
