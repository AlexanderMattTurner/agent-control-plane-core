#!/usr/bin/env bash
# Collect open security alerts (Dependabot, code scanning, secret scanning,
# pnpm audit, Socket.dev) into a single Markdown report. Writes the report to
# $REPORT_PATH and exports SECURITY_REPORT (first 50KB) to $GITHUB_ENV.
#
# Inputs (env):
#   GH_TOKEN       GitHub token (Dependabot/secret APIs require security_events scope)
#   REPO           owner/repo
#   GITHUB_ENV     Path to GitHub Actions env file (optional outside CI)
#   REPORT_PATH    Output report file (default: /tmp/security-report.md)

# The single-quoted jq programs below are literal jq source; $-tokens in them
# (e.g. `\($repo)`, `\(.number)`) are jq's, not the shell's, and must not be
# shell-expanded.
# shellcheck disable=SC2016

set -uo pipefail

: "${GH_TOKEN:?GH_TOKEN must be set}"
: "${REPO:?REPO must be set (owner/repo)}"
GITHUB_ENV="${GITHUB_ENV:-/dev/null}"
REPORT_PATH="${REPORT_PATH:-/tmp/security-report.md}"

api_tmp=$(mktemp)
api_out=$(mktemp)
api_err=$(mktemp)
audit_tmp=$(mktemp)
socket_tmp=$(mktemp)
pr_list_tmp=$(mktemp)
pr_list_err=$(mktemp)
trap 'rm -f "$api_tmp" "$api_out" "$api_err" "$audit_tmp" "$socket_tmp" "$pr_list_tmp" "$pr_list_err"' EXIT

# Quote a captured stderr file into the report as a Markdown blockquote. Every
# line gets the `> ` prefix, so no amount of API-controlled text can break out
# of the construct the way a ``` fence could.
#
# Bounded because the whole report is `head -c 50000`'d into $GITHUB_ENV: one
# oversized error body would otherwise crowd out the alert sections after it.
# Truncation is announced rather than silent — a clipped error that looks
# complete is exactly the kind of half-signal this script exists to avoid.
QUOTE_MAX_BYTES=4000
quote_file_into_report() {
  head -c "$QUOTE_MAX_BYTES" "$1" | sed 's/^/> /' >>"$REPORT_PATH"
  local size
  size=$(wc -c <"$1" | tr -d '[:space:]')
  # echo-fallback-ok: this IS report content, not a swallowed error.
  [[ "${size:-0}" -le "$QUOTE_MAX_BYTES" ]] ||
    printf '\n> _(error output truncated at %s bytes)_\n' "$QUOTE_MAX_BYTES" >>"$REPORT_PATH"
}

# Append a section heading + the alerts from one GitHub security endpoint.
#
# $REPO reaches jq through `--arg repo` rather than string interpolation, so
# jq parsing stays safe even if the repo slug ever contains special characters.
# That `--arg` must go to a real `jq` process: `gh api --jq` runs jq internally
# but exposes no way to bind named jq variables, so passing `--arg` to `gh api`
# is an unknown-flag error that fails the fetch outright. Hence the explicit
# fetch-then-pipe split below instead of a single `gh api --jq` call.
#
# echo-fallback-ok: this is a best-effort, per-section aggregator — one alert
# source failing must not abort the whole report. The three zero-line outcomes
# stay distinguishable on purpose: a failed fetch, an unparseable response, and
# a genuinely empty alert list each say so in their own words, and the failure
# paths quote the underlying error. Collapsing them would let a permissions
# failure render as a clean repo to this report's only consumer (a human, or
# the downstream Claude triage step).
gh_api_section() {
  local heading="$1" endpoint="$2" jq_expr="$3" fetch_error="$4" empty_msg="$5"
  {
    echo ""
    echo "$heading"
  } >>"$REPORT_PATH"

  if ! gh api "$endpoint" >"$api_tmp" 2>"$api_err"; then
    echo "$fetch_error" >>"$REPORT_PATH"
    quote_file_into_report "$api_err"
    return
  fi
  if ! jq -r --arg repo "$REPO" "$jq_expr" <"$api_tmp" >"$api_out" 2>"$api_err"; then
    echo "_Could not parse the API response for this section._" >>"$REPORT_PATH"
    quote_file_into_report "$api_err"
    return
  fi
  if [[ -s "$api_out" ]]; then
    cat "$api_out" >>"$REPORT_PATH"
  else
    echo "$empty_msg" >>"$REPORT_PATH"
  fi
}

: >"$REPORT_PATH"

gh_api_section \
  "## Dependabot Alerts" \
  "repos/${REPO}/dependabot/alerts?state=open&per_page=100" \
  '.[] | "- **\(.security_advisory.severity | ascii_upcase)**: [\(.security_advisory.summary)](https://github.com/\($repo)/security/dependabot/\(.number)) in `\(.dependency.package.name)` (\(.dependency.package.ecosystem))"' \
  "_Could not fetch Dependabot alerts (check repo permissions, or Dependabot alerts not enabled)._" \
  "_No open Dependabot alerts._"

gh_api_section \
  "## Code Scanning Alerts" \
  "repos/${REPO}/code-scanning/alerts?state=open&per_page=100" \
  '.[] | "- **\(.rule.severity // .rule.security_severity_level | ascii_upcase)**: [\(.rule.description)](https://github.com/\($repo)/security/code-scanning/\(.number)) at `\(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)`"' \
  "_Could not fetch code scanning alerts (check repo permissions, or code scanning not enabled)._" \
  "_No open code scanning alerts._"

gh_api_section \
  "## Secret Scanning Alerts" \
  "repos/${REPO}/secret-scanning/alerts?state=open&per_page=100" \
  '.[] | "- **\(.state | ascii_upcase)**: \(.secret_type_display_name) — [Alert #\(.number)](https://github.com/\($repo)/security/secret-scanning/\(.number))"' \
  "_Could not fetch secret scanning alerts (check repo permissions, or secret scanning not enabled)._" \
  "_No open secret scanning alerts._"

{
  echo ""
  echo "## pnpm audit"
} >>"$REPORT_PATH"
# Skip when there's no Node project — setup-base-env leaves pnpm uninstalled
# in that case, and `pnpm audit` would error out instead of returning "clean".
if [[ -f package.json ]]; then
<<<<<<< local
  # Capture to a file, then truncate from it. Piping straight into `head -100`
  # lets head close the pipe early and SIGPIPE-kill pnpm (exit 141), which
  # `pipefail` would surface as a spurious "audit encountered an error".
  pnpm audit >"$audit_tmp" 2>&1
  pnpm_rc=$?
  head -100 "$audit_tmp" >>"$REPORT_PATH"
||||||| base
  pnpm audit 2>&1 | head -100 >>"$REPORT_PATH"
  pnpm_rc=${PIPESTATUS[0]}
=======
  # Read pnpm's status from the command itself, and cap the report copy with a
  # consumer that reaches EOF. Capping with `head -100` instead would close the
  # pipe on any audit longer than that, SIGPIPE pnpm, and leave PIPESTATUS
  # holding 141 — reporting "audit encountered an error" for a run that worked.
  pnpm_output=$(pnpm audit 2>&1)
  pnpm_rc=$?
  printf '%s\n' "$pnpm_output" | awk 'NR <= 100' >>"$REPORT_PATH" # stderr-merge-ok: copied verbatim into the report so a reader sees pnpm's own diagnostics; never parsed or compared
>>>>>>> template
  # Exit 0 = clean, exit 1 = vulnerabilities found (expected); higher = real error
<<<<<<< local
  # echo-fallback-ok: best-effort report generator — noting the error in the
  # human-read report IS the intended recovery, not a value fed back into logic.
||||||| base
=======
  # echo-fallback-ok: this note is appended to a human-read report, never
  # captured or trusted as data — the real pnpm_rc is what the caller judges.
>>>>>>> template
  [[ "${pnpm_rc:-0}" -le 1 ]] || echo "_pnpm audit encountered an error (exit code $pnpm_rc); output above may be incomplete._" >>"$REPORT_PATH"
else
  echo "_Skipped: no package.json (not a Node project)._" >>"$REPORT_PATH"
fi

{
  echo ""
  echo "## Socket.dev Alerts"
} >>"$REPORT_PATH"

# Bot username is "socket-security[bot]" (as of 2025); if Socket changes
# their bot name this will silently return no results.
socket_found=false

# Branch on the PR-list fetch's exit code rather than discarding its stderr: a
# failed fetch (permissions/transient API error) must report "could not fetch"
# instead of yielding an empty list that reads as a clean "no alerts found".
if gh api "repos/${REPO}/pulls?state=open&per_page=5" --jq '.[].number' \
  >"$pr_list_tmp" 2>"$pr_list_err"; then
  while IFS= read -r pr_num; do
    [[ -n "$pr_num" ]] || continue
    # Fetch once into a temp file; avoids a second API call and command
    # substitution (which strips trailing newlines and merges multi-comment output).
    if ! gh api "repos/${REPO}/issues/${pr_num}/comments?per_page=30" \
      --jq '.[] | select(.user.login == "socket-security[bot]") | .body' \
      >"$socket_tmp" 2>/dev/null; then
      # Tolerate a single PR's comment fetch failing (permissions/transient API
      # error) — it must not abort the whole security report. Reset to empty so a
      # prior iteration's content can't leak into this PR's section.
      : >"$socket_tmp"
    fi
    if [[ -s "$socket_tmp" ]]; then
      socket_found=true
      {
        echo "### PR #${pr_num}"
        cat "$socket_tmp"
        echo ""
      } >>"$REPORT_PATH"
    fi
  done <"$pr_list_tmp"
  if [[ "$socket_found" = "false" ]]; then
    echo "_No Socket.dev alerts found in recent open PRs._" >>"$REPORT_PATH"
  fi
else
  echo "_Could not fetch open PRs for Socket.dev scan (check repo permissions)._" >>"$REPORT_PATH"
  quote_file_into_report "$pr_list_err"
fi

cat "$REPORT_PATH"

# Use a random sentinel to prevent delimiter injection — report content comes
# from external sources (advisory descriptions, bot comments) that an attacker
# could craft to contain a static sentinel and inject arbitrary env vars.
if [[ -r /proc/sys/kernel/random/uuid ]]; then
  report_sentinel="REPORT_EOF_$(cat /proc/sys/kernel/random/uuid)"
elif command -v uuidgen >/dev/null 2>&1; then
  report_sentinel="REPORT_EOF_$(uuidgen)"
else
  report_sentinel="REPORT_EOF_$$_${RANDOM}_${RANDOM}"
fi
report_size=$(wc -c <"$REPORT_PATH" | tr -d '[:space:]')
if [[ "$report_size" -gt 50000 ]]; then
  echo "::warning::Security report is ${report_size} bytes; truncating to 50 KB for \$GITHUB_ENV. Full report is at $REPORT_PATH on the runner."
fi
{
  echo "SECURITY_REPORT<<${report_sentinel}"
  head -c 50000 "$REPORT_PATH"
  echo ""
  echo "${report_sentinel}"
} >>"$GITHUB_ENV"
