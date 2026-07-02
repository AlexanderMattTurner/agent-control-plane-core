# Live-conformance: keeping golden fixtures honest against real agents

> Adapter-brief patch item ⑤. The golden fixtures in `src/fixtures/*.json` are
> hand-authored snapshots of each agent's real native hook payload. They rot
> **silently**: an agent ships a version that changes its hook JSON and the
> fixture — and the adapter built to it — drifts from reality with nothing to
> catch it. This doc describes the two tiers that guard against that, why the
> split exists, and the recipe for the tier that needs credentials.

## The hard constraint (why there are two tiers)

There is no way to capture a **real** hook payload from any of the four target
CLIs **deterministically and without provider credentials.** None of Claude
Code, Codex, Amp, or Gemini CLI ships a documented `--simulate` / `--dry-run` /
`test-hook` command that emits its PreToolUse payload offline; the payload is
produced only by the CLI's hook dispatcher **during an actual model turn**. So a
real capture always requires (a) the provider secret, (b) network, and (c) a
model turn that decides to call a tool — which is inherently nondeterministic
(the model may narrate, refuse, or pick another tool). This is confirmed against
each CLI's own docs (sources below).

That constraint forces the split: one tier is deterministic and secret-free and
runs unattended; the other needs secrets, network, and human-tolerant
nondeterminism, so it is documented for a maintainer to run deliberately rather
than wired as an automatic gate.

## Tier 1 — fixture-freshness (deterministic, secret-free, shipped)

`.github/scripts/check-fixture-freshness.mjs`, run by
`.github/workflows/fixture-freshness.yaml` on a weekly schedule (and
`workflow_dispatch`). It reads the SSOT `config/live-conformance.json`, queries
the **public npm registry** (no auth) for each CLI's latest published version,
and flags any adapter whose `captured_version` now lags that latest.

A newer published version does not _prove_ the fixture rotted, but it is the
signal to **re-capture against that version and re-run adapter conformance**. The
job is **advisory** — schedule/dispatch only, never `pull_request`:

- It compares against a **moving** `latest`, so gating a PR on it would turn the
  PR red for a version bump unrelated to its diff. A red run means "a newer CLI
  shipped, go re-verify," not "this repo is broken."
- The SSOT's own well-formedness _is_ gated on every PR, by
  `test/check-fixture-freshness.test.mjs` under the normal Node tests (the drift
  math, the rolling-release branch, and the shape of the shipped config).

`versioning: "rolling"` adapters (Amp — no semver release story) are reported
informationally and never marked drifted; comparing a rolling release against a
moving `latest` would flag perpetual, meaningless drift.

**Refresh procedure.** When Tier 1 flags drift: re-capture the agent's payload
(Tier 2 recipe below), diff it against `src/fixtures/<agent>.json`, update the
fixture + adapter if the shape changed, run `pnpm test`, and bump
`captured_version` in the SSOT to the version you verified against.

## Tier 2 — real-payload capture (secret-gated, `workflow_dispatch`-only, shipped)

This is the "install pinned CLI → canned session → assert real emission" tier.
It is now a real workflow — `.github/workflows/live-conformance.yaml`, run per
agent by `.github/scripts/live-capture/capture.mjs` — but a **manual,
secret-gated** one, never an automatic gate, because it cannot be made
deterministic or secret-free (see the hard constraint) and an auto-running flaky
job is worse than none.

**Safety properties.** `workflow_dispatch` only — it never runs on a push or PR
and can never wedge a branch. `capture.mjs` reads each agent's secret name from
the SSOT and **skips cleanly (exit 0 with a `::notice::`) when that secret is
unset**, so a run in a repo without credentials no-ops rather than failing. The
matrix is `fail-fast: false`, so one agent's failure doesn't cancel the others.

**What runs.** For the dispatched agent, `capture.mjs`:

1. installs the pinned CLI (`npm i -g <package>@<captured_version>`; a `rolling`
   agent installs `@latest`);
2. writes the capture hook config (`write-hook-config.mjs`) that registers
   `dump.mjs` — a node command that writes the payload the agent puts on stdin to
   `$ACP_CAPTURE_FILE` and exits 0 (allow) — matched to the agent's shell tool;
3. runs the CLI non-interactively with a canned "run `echo …`" prompt, **retrying
   up to 5 times** because a model turn may not call the tool first try;
4. asserts the captured payload still parses (`assert-captured.mjs`:
   `adapter.parse` yields a well-formed `ToolCallEvent`; an empty capture "the
   hook never fired" and a drifted shape both fail loud).

**What is and isn't verified.** Steps 2 and 4 — the config generation and the
payload assertion — are **deterministic and unit-tested** (`test/live-capture.test.mjs`,
the assertion driven by the golden fixtures' own native payloads) and gated on
every PR by the normal Node tests. Steps 1 and 3 — the install and the live model
turn — **cannot be exercised without the provider secrets and a real CLI**, so
the install commands and the run invocations below are **research-derived and not
verified against a live CLI**; the maintainer's first dispatch is expected to
iterate on per-version flags (especially the flag that lets a tool call proceed
without an interactive approval prompt, and Amp — see the low-confidence note).

### Per-agent specifics (from research; verify at pin time)

| Agent           | Package (npm)               | Versioning | Event        | Shell-tool matcher | Secret              | Notes                                                                                                                                                                                                                                                                                                                                      |
| --------------- | --------------------------- | ---------- | ------------ | ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Claude Code** | `@anthropic-ai/claude-code` | semver     | `PreToolUse` | `Bash`             | `ANTHROPIC_API_KEY` | Hook config in `.claude/settings.json`; payload fields `hook_event_name`/`tool_name`/`tool_input` (+ `prompt_id` on v2.1.196+). Non-interactive: `claude -p "run echo hi"`.                                                                                                                                                                |
| **Codex CLI**   | `@openai/codex`             | semver     | `PreToolUse` | `^Bash$`           | `OPENAI_API_KEY`\*  | Most Claude-compatible hook shape. Config in `hooks.json` or `~/.codex/config.toml`. Non-interactive: `codex exec "run echo hi"`. \*or ChatGPT login.                                                                                                                                                                                      |
| **Amp**         | `@sourcegraph/amp`          | rolling    | `delegate`   | `Bash`             | `AMP_API_KEY`       | **Low confidence** — Amp's hook event strings / payload field names are behind an auth-walled manual and _unconfirmed_. Its permission/delegate path passes tool params as JSON on stdin + decides by exit code; whether a _hook_ can shell out to a stdin-dumper is unverified. Confirm against the Owner's Manual before automating Amp. |

Gemini CLI (`@google/gemini-cli`, event **`BeforeTool`**, matcher `run_.*`,
secret `GEMINI_API_KEY`, hooks since v0.26.0) is listed for completeness but has
**no shipped adapter yet** (see `schema-fit.md`); add it to the SSOT when its
adapter lands.

## What Tier 2 would resolve

The `❓` cells in [`hook-coverage-matrix.md`](./hook-coverage-matrix.md) — does
the hook actually fire on MCP tools, subagent-spawned calls, resumed sessions? —
are exactly what a live capture answers. A canned session that exercises each
call class and checks whether the hook fired converts a `❓` into a confirmed
`this_call_vetoable` value. Until then, per that doc, an unconfirmed cell is
treated as un-vetoable (degrade `deny` → notify), never assumed covered.

## Sources

- Claude Code hooks — [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks) · [npm](https://www.npmjs.com/package/@anthropic-ai/claude-code)
- Codex hooks — [developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks) · [npm](https://www.npmjs.com/package/@openai/codex)
- Amp — [ampcode.com/manual](https://ampcode.com/manual) · [npm](https://www.npmjs.com/package/@sourcegraph/amp) (hook payload fields unconfirmed, auth-walled)
- Gemini CLI hooks — [geminicli.com/docs/hooks/reference](https://geminicli.com/docs/hooks/reference/) · [npm](https://www.npmjs.com/package/@google/gemini-cli)
