#!/usr/bin/env bash
# Download the pinned gitleaks CLI (MIT — no GITLEAKS_LICENSE needed, unlike the
# gitleaks-action on org accounts) and scan the working tree for secrets.
# gitleaks exits non-zero when it finds a leak, which fails the CI step.
set -euo pipefail

ver="${GITLEAKS_VERSION:?GITLEAKS_VERSION not set}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

url="https://github.com/gitleaks/gitleaks/releases/download/v${ver}/gitleaks_${ver}_linux_x64.tar.gz"
curl -sSfL "$url" -o "$tmp/gitleaks.tar.gz"
tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks

"$tmp/gitleaks" dir . --redact --verbose
