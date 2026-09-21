#!/usr/bin/env bash
# Install the agent-input-sanitizer package sanitize-pr-input.mjs imports. The
# merge-delta reviewer is the only caller left: the first-pass reviewer runs
# from AlexanderMattTurner/agent-review, which installs its own copy.
# Installs into .github/scripts/node_modules so ESM resolution from that
# script finds it without touching the repository's own package.json or
# lockfile — repos synced from this template need no sanitizer dependency of
# their own. This script is the single source of the pinned version.
set -euo pipefail

SANITIZER_VERSION="1.38.0"

npm install --prefix .github/scripts --no-save --no-package-lock \
  --ignore-scripts --no-audit --no-fund \
  "agent-input-sanitizer@${SANITIZER_VERSION}"
