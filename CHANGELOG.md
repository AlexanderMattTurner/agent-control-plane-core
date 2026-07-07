# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to
adhere to [Semantic Versioning](https://semver.org/).

Add user-facing changes under `## Unreleased` as you make them. On each push to
the default branch, `auto-version.yaml` publishes to npm and promotes the
`## Unreleased` block into a new dated `## [version]` section below it (see
`.github/scripts/version-bump.sh`); when `## Unreleased` is empty, Claude drafts
the prose from the release's commits.

## Unreleased

### Added

- `sanitizeVerdict(verdict, sanitizeText)`: hardens an UNTRUSTED Verdict (one
  authored by a separate monitor/judge process) before render. An invalid
  `decision` is clamped to `"ask"` (fail-to-ask) with an observable clamp note
  appended to `reason`; the injected `sanitizeText` runs over the
  monitor-authored prose fields (`reason`, `additional_context`) but never over
  the `mutated_input`/`mutated_output` data channels. Throws on a non-function
  sanitizer or a sanitizer returning a non-string. Additive — stays schema v1.
- `Verdict.mutated_output`: the normalized channel for a PostToolUse content
  transform (redaction/sanitize), so an output-rewriting hook can route through
  the contract. Rendered by the Claude adapter as
  `hookSpecificOutput.updatedToolOutput`. Additive — stays schema v1.
- Tool-identity normalization: `event.tool` is now the CANONICAL tool name
  (a native alias such as Gemini's `run_shell_command` is normalized to `Bash`),
  with the raw native name preserved on `meta.native_tool`. Driven by the
  `TOOL_ALIASES` SSOT (`canonicalTool()`), whose targets must be `MODELED_TOOLS`
  members and whose every entry must be witnessed by a conformance fixture
  (`assertToolAliasesCovered`). An unknown tool is never reclassified — it passes
  through verbatim. Additive — stays schema v1.

### Removed

- `NativeResponse.throw_` / `NativeResponse.fallback` and the `ConfigFallback`
  typedef — speculative surface no shipped adapter emitted. They will return
  additively (still v1) when the opencode / OpenHands adapters that need them
  land with fixtures. The enforcement-honesty conformance check now requires an
  enforced deny to carry a non-zero `exit_code` (the only block signal any
  shipped adapter produces).
