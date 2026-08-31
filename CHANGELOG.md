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

## [0.6.0] - 2026-08-31

### Fixed

- Every adapter now maps the whole optional `EventMeta` set — `session_id`, `cwd`, `permission_mode`, `transcript_path` — through the contract's new `baseMeta`. Each adapter used to assemble that meta by hand, the Gemini copy omitted `permission_mode` and the Amp copy omitted both `permission_mode` and `transcript_path`, so a guardrail keyed on `event.meta.permission_mode` read `undefined` for those agents alone while Claude and Codex answered. A mapped field is also consumed, so it can never appear a second time in `meta.passthrough`.
- The Gemini adapter renames a builtin tool and its input keys together, or does neither. `read_file` was renamed to `Read` unconditionally while the `absolute_path` → `file_path` rename only fired when the payload supplied `absolute_path`, so a payload without it produced `event.tool: "Read"` with no `input.file_path` — a judge told "this is a Read" read `undefined` and allowed. The alias now applies only when the renamed input carries the key the canonical name advertises; otherwise the call keeps its native name, which promises nothing. This covers `write_file` → `Write` too, where no input rename exists and the native payload may still omit `file_path`.
- The Amp adapter carries an enforced deny's `reason` on `NativeResponse.stderr`, which `emit` writes to fd 2. Amp's delegate is a PATH helper whose stderr Amp surfaces, so the render dropping the reason meant a blocked call reached the user with no rationale. Non-enforced renders still say nothing on fd 2: they have blocked nothing.
- A `mutated_output` redaction verdict on a Gemini CLI `AfterTool` event rendered a bare exit 0, so the UNREDACTED tool output reached the model with nothing saying so. Gemini documents no output-rewrite field, so the adapter now declares the drop and renders a `systemMessage` warning telling the model the output above it is unvetted. A guardrail that must actually redact has to deny the call on this host.
- The Gemini adapter no longer emits `hookSpecificOutput.tool_input` on `AfterTool`, and the Claude adapter no longer emits `hookSpecificOutput.updatedToolOutput` on `UserPromptSubmit`/`SessionStart`. Both named a channel the host ignores, which read back to the caller as a mutation that was applied.
- No adapter writes a verdict's content into an `EventKind.UNKNOWN` render any more. An event the adapter could not name has no established host channel, so Codex's `updatedInput`, Gemini's `systemMessage` and Claude's `additionalContext` are all dropped there. Codex routes every native event it does not model into UNKNOWN — `SessionStart` and `Stop` among them — so this was its ordinary path rather than drift.
- CI scripts no longer abort on SIGPIPE when running release and template-sync operations, which was a spurious failure path on systems where pipes closed early.

### Added

- `classifyCallClass` returns `CallClass.SUBAGENT` for a payload carrying a non-empty `agent_type`, so an adapter's SUBAGENT coverage row is now load-bearing on any host that stamps that field. MCP is still checked first (an MCP call from inside a subagent goes out through the host's MCP surface either way), and only a non-empty string counts — a host that stamps the key empty on a main-thread call is saying "no subagent", and reading that as one would degrade every ordinary call on a host whose SUBAGENT row is ❓. Claude Code carries the field and its subagent row is COVERED; Codex carries it too, which its docs and [openai/codex#16226](https://github.com/openai/codex/issues/16226) (open) both deny — a live probe read `agent_type=default` off a subagent's `PreToolUse` payload and found it absent on the main thread's. Gemini CLI documents none, so its ❓ row answers the day a payload names an agent. RESUMED stays undetectable on every host: a resumed session announces itself on `SessionStart`, not on its tool payloads, and `parse` keeps no cross-event state.
- The Codex adapter models `PostToolUse`. It used to route every native event but `PreToolUse`/`PermissionRequest` into `EventKind.UNKNOWN`, so a consumer on a Codex that emits `PostToolUse` renders a noop where a post-hook render is expected.

## [0.5.3] - 2026-08-18

### Fixed

- The release-docs fallback pull request keeps its own checks running, so a release that cannot push to `main` still reports.
- `auto-version` opens a release-docs pull request when a branch ruleset blocks the direct push to `main`.

## [0.5.2] - 2026-08-18

### Changed

- The merge-conflict resolver is called from its own repository, pinned by SHA.

### Fixed

- The auto-resolve path no longer receives a metered API key.
- Restored the protected-set coverage, and corrected the citations in `git-auth`.
- The called auto-resolve workflow runs under a permissions ceiling.
- `template-sync` stages the resolver, so the model tier still runs.

## [0.5.1] - 2026-08-17

### Fixed

- The control plane refuses a vetoable `UNKNOWN` at the constructor instead of in conformance.
- The conformance drift probe bites on the Codex adapter, and the gated sets stay private.

## [0.5.0] - 2026-08-17

### Changed

- **Breaking:** an unmodelled event never reports an enforced block.

## [0.4.3] - 2026-08-17

### Fixed

- The hook runtime writes the whole response body, instead of one short `writeSync`.
- An adapter renders an unenforceable deny as `ask`, never as Amp's allow.

## [0.4.2] - 2026-08-17

### Fixed

- The conformance aliased-input check runs against a live `parse`, not the fixture file.

## [0.4.1] - 2026-08-17

### Fixed

- The release job gets `uv`, so its docs commit can be pushed.
- `.github/tool-versions.sh` is synced from the template.

## [0.4.0] - 2026-08-17

### Changed

- **Breaking:** the Gemini adapter canonicalizes an aliased tool's INPUT, and the `web_fetch` alias is dropped.
- `MODELED_TOOLS` is derived from the input-key map, and the new export is pinned.

### Fixed

- A malformed judge verdict is clamped to `ask`, and conformance asserts that a deny must block.

## [0.3.2] - 2026-08-10

### Fixed

- The sync installs `.github/tool-versions.sh`, the pin file `install-mergiraf.sh` sources.
- The local zizmor hook runs offline.

## [0.3.1] - 2026-08-10

### Fixed

- `template-sync` syncs the pin files that the synced scripts source.
- The release job gets the pre-commit that the pre-push hook demands.

### Changed

- The documentation says which `SYNC_PATHS` entries are load-bearing, and records the releases the stranded docs push lost.

## [0.3.0] - 2026-08-10

### Added

- An `agent-control-plane-core/contract` subpath export carrying `Decision`, `EventKind`, `normalizeVerdict` and `makeEvent`. It reaches no adapter, no registry and no conformance module, so a consumer that needs only the contract pays 9 ms of import work instead of the barrel's 31 ms. A guardrail hook is one process per tool call, which is where that difference is spent.

## [0.2.18] - 2026-08-10

### Fixed

- Restored the executable bit on the scripts the GitHub contents API had written back without it.

## [0.2.17] - 2026-08-10

### Fixed

- `.hooks/pre-push` computes the pushed range before it demands `pre-commit`, so a push with nothing new to check — a release tag on a commit the remote already has — is no longer refused on a runner without the tool.

## [0.2.16] - 2026-08-10

### Fixed

- The live-capture env map is built without a prototype, so an env var named after an `Object.prototype` member can no longer be read as an inherited value.
- template-sync no longer writes a trailing space into `.template-sync-conflicts`.
- Restored the executable bit on the two hook scripts, and the verbatim bytes of two files a worktree round-trip had re-encoded.

### Changed

- The hook entry-point check comes from `cli-args` instead of a second local implementation; declarations regenerated to match.

## [0.2.15] - 2026-08-03

### Changed

- Synced the automation template (`.claude`, `.hooks`, `.github`).

## [0.2.14] - 2026-08-03

### Fixed

- Pinned ci-truth-serum to a commit that includes release-canary support, resolving linting issues introduced by the dependency.

## [0.2.13] - 2026-07-23

### Changed

- test: assert spawn success, tie live-conformance to fixtures, strengthen capture
- test(conformance): prove the alias skip path and witness the un-gated MCP class
- test(codex): exact default-deny-reason and version-gate boundary from SSOT
- docs: release 0.2.12 [skip ci]

## [0.2.12] - 2026-07-22

### Changed

- style: satisfy ruff-format blank-line rule in test_template_sync
- test(freshness): cover the drift→exit-code gate (extract reportFreshness)
- fix(gemini): carry the enforced-deny reason on NativeResponse.stderr
- docs(control-plane): reconcile the removed external_pin channel
- fix(hook-runtime): flush deny body before exit; trace non-object payloads
- fix(control-plane): eliminate untrusted-key map lookups and validate events
- docs: release 0.2.11 [skip ci]

## [0.2.11] - 2026-07-21

### Changed

- ci: use TEMPLATE_SYNC_TOKEN_ORG as the primary template-sync token
- docs: release 0.2.10 [skip ci]

## [0.2.10] - 2026-07-21

### Changed

- ci: add TEMPLATE_SYNC_TOKEN_ORG as template-sync token fallback
- docs: release 0.2.9 [skip ci]

## [0.2.9] - 2026-07-21

### Changed

- ci: re-exec template-sync from immutable copy and add self-overwrite regression test
- docs: release 0.2.8 [skip ci]

## [0.2.8] - 2026-07-21

### Changed

- style: apply prettier to promote-changelog.mjs
- refactor: use semver package for version parsing
- docs: release 0.2.7 [skip ci]

## [0.2.7] - 2026-07-21

### Changed

- fix(security): replace unverified webi curl|sh bootstrap with pinned, verified installs (#34)
- docs: release 0.2.6 [skip ci]

## [0.2.6] - 2026-07-21

### Changed

- test: make session-setup GH_REPO test hermetic against ambient git rewrite
- chore(deps): relock uv.lock after package rename
- docs: add parallel-session overlap convention to CLAUDE.md
- ci(pre-commit): enable ci-truth-serum check-symlinks
- fix(hooks): warn loudly when lint-staged is missing in pre-commit
- ci: add daily release-canary workflow
- test: guard test-dir layout and fail CI loudly on missing toolchain
- chore(meta): fix template-leftover project name and stale adapter list
- fix(ci): push the release tag before the CHANGELOG docs push
- fix(hooks): emit stderr diagnostic when the hook pipeline fails safe

## [0.2.5] - 2026-07-19

### Changed

- ci: run template sync daily instead of weekly (#32)
- ci: notify on Sync from Template workflow failures (#31)

## [0.2.3] - 2026-07-13

### Security

- Codex adapter: an enforced `deny` now always renders a non-empty `permissionDecisionReason`. Codex's `PreToolUse` output parser drops a deny that carries no (or an empty) reason and **runs the tool** (fail-open); the adapter now substitutes a default reason so a reasonless enforced deny still blocks. Claude honours a bare deny; Codex does not — this closes the gap at the adapter boundary rather than relying on every judge to supply a reason.

## [0.2.1] - 2026-07-09

### Security

- Hardened CI workflows against PR-author code execution and prompt injection attacks.

## [0.2.0] - 2026-07-09

### Added

- `sanitizeVerdict(verdict, sanitizeText)`: hardens an UNTRUSTED Verdict (one
  authored by a separate monitor/judge process) before render. An invalid
  `decision` is clamped to `"ask"` (fail-to-ask) with an observable clamp note
  appended to `reason`; the injected `sanitizeText` runs over the
  monitor-authored prose fields (`reason`, `additional_context`) but never over
  the `mutated_input`/`mutated_output` data channels. Throws on a non-function
  sanitizer or a sanitizer returning a non-string. Additive — stays schema v1.
- Gemini adapter: `BeforeAgent` (Gemini CLI v0.26.0+) now maps to
  `prompt_submit`, folding the submitted text into `input.prompt`. Renders
  honestly against BeforeAgent's documented channels: enforced deny → exit 2
  (aborts the turn), ask → the exit-0 `decision: "deny"` body (Gemini has no
  native ask tier), `additional_context` →
  `hookSpecificOutput.additionalContext`, allow abstains. Additive — stays
  schema v1.
- Gemini adapter: adapter-scoped builtin tool aliases (`GEMINI_TOOL_ALIASES`,
  exported): a call classified BUILTIN canonicalizes `read_file` → `Read`,
  `write_file` → `Write`, `web_fetch` → `WebFetch` (Gemini CLI registers every
  MCP tool under an `mcp_{server}_{tool}` fully qualified name, so a bare
  builtin name in a hook payload is unambiguous). The native input fields still
  pass through verbatim, with the raw name on `meta.native_tool`; an MCP-
  classified call is never aliased. `assertToolAliasesCovered` now takes an
  optional per-adapter alias map and requires each scoped alias to be witnessed
  by that agent's own fixtures. Additive — stays schema v1.
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
- Agent-id → adapter registry SSOT: a canonical mapping of agent identifiers to
  their adapter implementations for consistent registry lookups.

### Fixed

- `sanitizeVerdict` now correctly forwards a non-object `mutated_input` instead
  of dropping it.
- npm provenance validation now succeeds on publish with added repository
  metadata in package.json.

### Removed

- `NativeResponse.throw_` / `NativeResponse.fallback` and the `ConfigFallback`
  typedef — speculative surface no shipped adapter emitted. They will return
  additively (still v1) when the opencode / OpenHands adapters that need them
  land with fixtures. The enforcement-honesty conformance check now requires an
  enforced deny to carry a non-zero `exit_code` (the only block signal any
  shipped adapter produces).
