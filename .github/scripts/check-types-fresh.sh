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

if ! pnpm build; then
  echo "::error::pnpm build failed — types/ cannot be verified" >&2
  exit 1
fi

if git diff --quiet --exit-code -- types/; then
  exit 0
fi

git diff -- types/
echo "::error::types/ is stale — run \`pnpm build\` and commit the result" >&2
exit 1
