#!/usr/bin/env bash
# Fail when `types/` does not match what `pnpm build` produces right now.
#
# `types/` is committed tsc output, and it is what an editor and a type checker
# read as this package's API. Nothing else rebuilds it, so a source change
# landed without `pnpm build` leaves a declaration that contradicts the source
# it declares — and tsc warns nobody, because the declaration IS what it checks
# against. `types/adapters/codex.d.mts` carried `NATIVE_ASK_TIER: true` for a
# release cycle while `src/adapters/codex.mjs` said `false`.
#
# `prepublishOnly` rebuilds before an npm publish, so the tarball escaped that
# one. Nothing rebuilds for a git dependency, a workspace link, or a person
# reading the repo, which is who this check covers.
#
# Writes every diagnostic to stderr and leaves the diff on stdout, so a reader
# of the job log sees which declaration drifted without opening an artifact.

set -uo pipefail

# `pnpm build` writes over `types/`; it never deletes from it. So a source
# module that was REMOVED leaves its old declaration behind, tracked and
# byte-identical, and a diff of the rebuilt tree reports clean while the package
# still publishes an API for code that no longer exists. Emptying the directory
# first makes the leftover show up as a deletion.
find types -type f -delete 2>/dev/null

if ! pnpm build; then
  # The delete above already happened, so hand the committed tree back rather
  # than leaving whoever ran this with no `types/` at all.
  git checkout -- types/ 2>/dev/null
  echo "::error::pnpm build failed — types/ cannot be verified" >&2
  exit 1
fi

# `git diff` reads the index, and an UNTRACKED file is not in it — so a new
# source module whose `.d.mts` was never committed leaves a file `git diff`
# cannot see, and the gate would pass green over an incomplete `types/`. That is
# the same drift this exists to close. `--intent-to-add` registers the path
# without staging its content, which is exactly enough for the diff to report it.
git add --intent-to-add -- types/

# Against HEAD, not the index. `git add` records a REMOVAL in the index, so the
# same command that registers an added declaration also stages a deleted one —
# and a plain `git diff`, which compares the worktree to the index, then reports
# a `types/` the build left empty as clean.
if git diff --quiet --exit-code HEAD -- types/; then
  exit 0
fi

git diff HEAD -- types/
echo "::error::types/ is stale — run \`pnpm build\` and commit the result" >&2
exit 1
