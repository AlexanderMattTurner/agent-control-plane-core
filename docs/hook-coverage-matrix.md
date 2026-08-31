# Hook-coverage matrix: does the guardrail hook actually FIRE per call class?

> Research backing for patch item ③. This is a doc, **not** code — it does not
> touch `conformance.mjs`. The conformance suite today pins adapter parse/render
> **shape**; item ③ wants that supplemented by a **coverage matrix**: for each
> host and each _class_ of tool call, does the pre-tool guardrail hook fire at
> all? A call the hook never sees is un-vetoable regardless of what the
> adapter's `render` would produce for it. This doc assembles the evidence for
> later teaching conformance to enforce such a matrix; it decides nothing about
> the schema.

**Status: now enforced.** The matrix below is encoded as each adapter's frozen
`COVERAGE` map (`CallClass` → `CoverageStatus`, `src/control-plane.mjs`), and the
conformance harness (`runAdapterConformance`) checks it three ways: every adapter
classifies exactly the canonical `CALL_CLASSES`; a fixture case tagged with a
`call_class` whose status doesn't permit a veto (uncovered/unknown — an ❓ is
treated as ❌ via `coverageAllowsVeto`) MUST parse `this_call_vetoable: false`;
and each adapter's `parse` derives vetoability from its own row, so an MCP-sourced
call on a host whose MCP cell is not ✅ (Codex ❌, Gemini ❓) parses non-vetoable.
The subagent cell is live on hosts that stamp `agent_type` (Claude Code, Codex);
the resumed cell stays advisory-only in code, because no host marks a lone tool
event as belonging to a resumed session — the tables below remain the SSOT for
what each cell claims.

## Why "hook fires?" is exactly `this_call_vetoable`

`ToolCallEvent.this_call_vetoable` (`src/control-plane.mjs`) is defined as:
"false ⇒ the guardrail cannot veto THIS call; a monitor must auto-degrade deny
to notify, and any render of it stays advisory (never `enforced`)." That is the
schema's exact handle for a hook-coverage hole:

- **Hook fires on this call class** ⇒ the adapter constructs a `ToolCallEvent`
  the guardrail can actually block ⇒ `this_call_vetoable: true`.
- **Hook does NOT fire on this call class** ⇒ the call reaches the tool without
  the adapter ever seeing it. Two sub-shapes, both already observed in
  [`schema-fit.md`](./schema-fit.md):
  1. _Event parsed but marked unvetoable_ — the adapter can build an event from
     some other signal about the call but knows the guardrail is out of the
     execution path ⇒ set `this_call_vetoable: false`, and the monitor degrades
     `deny → notify`.
  2. _Event never parsed_ — the host emits nothing for this call class, so no
     `ToolCallEvent` is constructed at all (opencode's MCP gap and OpenHands's
     `execute_tool()` bypass are this shape; see `schema-fit.md` §opencode,
     §OpenHands(d)). Conformance can only defend against this by _asserting the
     host fires_ — the adapter has nothing to mark.

The practical consequence is the same in both sub-shapes: **a monitor must not
render `deny` as `enforced` for a call class the host does not gate.** A cell
marked "no" below is a place an adapter must hard-code `this_call_vetoable:
false` (sub-shape 1) or where the event never arrives (sub-shape 2) — either way
the monitor may only notify, never block.

## The matrix

Rows = call classes. Columns = the five hosts we have or plan `{parse, render}`
adapters for. Legend: **✅** pre-tool hook fires (call is vetoable) · **❌** does
not fire (un-vetoable) · **⚠️** partial (only some tools in the class fire) ·
**❓** unknown — undocumented, needs a live probe (item ⑤). An honest ❓ is the
point: a guessed ✅ is a silent fail-open.

| Call class                    | Claude Code | Codex CLI             | Amp               | opencode        | Gemini CLI               |
| ----------------------------- | ----------- | --------------------- | ----------------- | --------------- | ------------------------ |
| **Builtin tool**              | ✅ [C1]     | ⚠️ Bash only [X1][X2] | ✅ [A1]           | ✅ [O1]         | ✅ (v0.26+) [G1]         |
| **MCP-server tool**           | ✅ [C2]     | ❌ [X1][X2]           | ✅ [A2]           | ❌ #2319 [O2]   | ✅ likely, med-conf [G2] |
| **Subagent-spawned tool**     | ✅ [C3]     | ⚠️ Bash only [X3]     | ✅ (context) [A3] | ❓ [O3]         | ⚠️ load-bug [G3]         |
| **Resumed/continued session** | ✅ [C4]     | ⚠️ Bash only [X4]     | ✅ struct. [A4]   | ✅ struct. [O4] | ❓ [G4]                  |

### Per-cell reasons + citations

**Claude Code** (`external_hook`; `PreToolUse` subprocess, stdin/stdout JSON)

- **[C1] builtin ✅** — `PreToolUse` fires after params are built, before the
  tool runs, for every builtin (Bash/Edit/Write/Read/…). [Hooks reference](https://code.claude.com/docs/en/hooks).
- **[C2] MCP ✅** — MCP tools surface as regular tools named
  `mcp__<server>__<tool>` and route through the **same** `PreToolUse`; no second
  model for local vs. remote. [Hooks reference](https://code.claude.com/docs/en/hooks).
- **[C3] subagent ✅** — hooks fire for **every** tool a subagent (Agent/Task
  tool) uses; the hook input carries `agent_id`/`agent_type`, and subagents do
  **not** inherit the parent's permissions, so the `PreToolUse` hook is often
  the _only_ gate on a subagent's calls. [Agent SDK hooks](https://platform.claude.com/docs/en/agent-sdk/hooks).
- **[C4] resumed ✅ (structural)** — hooks are re-read from settings on session
  load, so new tool calls in a `--resume`/`--continue` session fire `PreToolUse`
  normally. Not separately citation-confirmed for resumed sessions specifically;
  the structural reason (config reloaded, hook fires per _new_ call) is solid,
  but a live probe (item ⑤) would harden it.

**Codex CLI** (`external_hook`; `PreToolUse`/`PostToolUse` modeled on Claude
Code, version-gated — shipped adapter pins `MIN_ENFORCING_VERSION [0,135]` in
`src/adapters/codex.mjs`)

- **[X1] builtin ⚠️ Bash only** — `PreToolUse` "intercepts the shell (Bash) tool
  only — by design." `apply_patch`, Read/Edit/Write, and web fetch do **not**
  fire it, so a hook-only layer never sees a Codex file edit. Medium confidence
  (third-party reference, corroborated below).
  [ACP Codex hooks reference](https://agenticcontrolplane.com/blog/codex-cli-hooks-reference);
  [OpenAI Codex hooks docs](https://developers.openai.com/codex/hooks).
- **[X2] MCP ❌** — MCP tool calls are explicitly outside `PreToolUse` coverage.
  Same sources as [X1]. This is a confirmed un-vetoable class today.
- **[X3] subagent ⚠️ Bash only (probe-confirmed)** — no source documented this
  either way, so it was ❓ until an item-⑤ probe ran it. The probe drove a real
  subagent and reports `subagent_pretooluse=covered`: `PreToolUse` fires for a
  subagent's shell call, under the same Bash-only limit as [X1] ⇒ PARTIAL, not
  ❓. The probe also settled the RUNTIME question the docs answered wrongly:
  a subagent's `PreToolUse` payload carries `agent_id` and `agent_type`
  (`agent_type=default`, `agent_id` equal to the one `SubagentStart` announced),
  and both are ABSENT from a main-thread call's — so `classifyCallClass` reads
  this row from one payload, no correlation needed. The published field list and
  [openai/codex#16226](https://github.com/openai/codex/issues/16226) (still open,
  asking for exactly these fields) are both stale on this point; the measurement
  wins. Probe runs `33346707822`, `33347870937` on `claude/sbx-codex-support-gtknyl`.
- **[X4] resumed ⚠️ Bash only (probe-confirmed)** — same probe:
  `resumed_pretooluse=covered`, so a `codex exec resume` session re-arms the hook
  surface and its new calls fire `PreToolUse` ⇒ PARTIAL. Its SESSION does
  announce itself — `session_start_sources=startup,resume,startup` across the
  probe's three legs, i.e. `SessionStart` carries `source: "resume"` — but the
  tool payloads carry no resume marker of their own, so `classifyCallClass`
  cannot answer RESUMED from a lone pre-tool event and such a call is classified
  by its tool. Correlating the two events would need cross-event state, which
  `parse` deliberately does not keep.
- **[X6] sandbox note (same probe)** — `codex exec resume` ignores `-C`: the
  workdir is restored from the session record, not taken from the invocation, so
  a resumed session's write boundary is inherited from wherever the session was
  first created. Resuming from inside a narrow directory does **not** narrow it.
  Relevant to any deployment that treats the sandbox as the backstop for the
  classes this matrix leaves un-gated (see `docs/monitor-invariants.md`).
- **[X5] scope of [X1]–[X4]** — these four rows describe `PreToolUse` routing;
  that is what the sources speak about. `PostToolUse` has a wider surface: it
  "runs after supported tools produce output", `apply_patch` and MCP calls
  included, and honours `decision: "block"` (exit 2 blocks further processing)
  but cannot rewrite the output. So `src/adapters/codex.mjs` applies COVERAGE to
  a pre-tool event only — a `PostToolUse` payload in hand is proof the post-tool
  hook fired for that call, and judging it by the pre-tool MCP ❌ would degrade a
  block Codex honours into a notify.
  [OpenAI Codex hooks docs](https://developers.openai.com/codex/hooks).

**Amp** (`external_hook`; per-tool permission engine, decision = delegate binary
exit code — already shipped adapter)

- **[A1] builtin ✅** — every tool call is checked against the permission list;
  a matched rule can `allow`/`reject`/`ask`/`delegate` (delegate = run an
  external program, the guardrail seam). [Tool-level permissions](https://ampcode.com/news/tool-level-permissions).
- **[A2] MCP ✅** — `amp.mcpPermissions` uses the **same** pattern-matching rule
  syntax; `delegate` targets like `mcp__playwright__*` are first-class.
  [MCP permissions](https://ampcode.com/news/mcp-permissions).
- **[A3] subagent ✅** — permission rules take a `context` selector; e.g.
  `create_permission("Bash", "reject", { "context": "subagent" })` gates calls
  **only** in a subagent context — so the gate demonstrably runs inside
  subagents (main-thread and subagent both). [Tool-level permissions](https://ampcode.com/news/tool-level-permissions).
- **[A4] resumed ✅ (structural)** — permissions are evaluated per tool call at
  call time, independent of whether the thread is new or continued; a resumed
  thread's new calls hit the same gate. Not documented for `threads continue`
  specifically, but call-time evaluation makes fail-through implausible.

**opencode** (`in_process`; JS/TS plugin, `tool.execute.before`/`after` —
schema's reference case for `NativeResponse.throw_`)

- **[O1] builtin ✅** — `tool.execute.before(input, output)` fires for builtin
  tool calls; deny = throw, allow = return (optionally mutating `output`).
  [opencode plugins](https://open-code.ai/en/docs/plugins).
- **[O2] MCP ❌** — MCP-sourced tool calls do **not** trigger
  `tool.execute.before`/`after` at all. Confirmed bug, no config-level MCP
  deny-wildcard fallback documented ⇒ event never parsed (sub-shape 2).
  [sst/opencode#2319](https://github.com/sst/opencode/issues/2319).
- **[O3] subagent ❓** — opencode has subagents/agents, but whether
  `tool.execute.before` fires for a subagent's builtin tool calls is
  undocumented. Given the MCP wiring gap ([O2]) shows opencode's hook and
  tool-dispatch surfaces are not uniformly wired, do **not** assume ✅ — mark
  unknown, resolve by probe.
- **[O4] resumed ✅ (structural)** — the plugin is loaded into the process and
  intercepts in-process tool executions; a resumed session's new **builtin**
  calls still fire `tool.execute.before` (MCP still won't, per [O2]). Structural,
  not separately cited.

**Gemini CLI** (`external_hook`; `BeforeTool`/`AfterTool`/`AfterAgent`
subprocess hooks, stdin/stdout JSON — needs its own version gate + fail-open
semantics, see `schema-fit.md` §Gemini CLI)

- **[G1] builtin ✅ (v0.26.0+)** — hooks shipped in v0.26.0; pre-0.26 has **no**
  hook surface at all (whole host `observe_only`, unconditionally
  `this_call_vetoable: false`). [Gemini hooks launch](https://developers.googleblog.com/tailor-gemini-cli-to-your-workflow-with-hooks/);
  [Gemini hooks reference](https://geminicli.com/docs/hooks/reference/).
- **[G2] MCP ✅ likely (medium confidence)** — MCP tools are named
  `mcp_<server>_<tool>` and matched by the same hook `matcher` patterns as
  builtins, which _suggests_ they route through `BeforeTool` (unlike opencode).
  Not a worked example — flagged medium-confidence in `schema-fit.md`; a probe
  should confirm before an adapter marks these vetoable.
- **[G3] subagent ⚠️ load-bug** — custom subagents (`~/.gemini/agents/`) whose
  tool list includes MCP tools **fail to load/validate** at all
  ([#17005](https://github.com/google-gemini/gemini-cli/issues/17005),
  [#18712](https://github.com/google-gemini/gemini-cli/issues/18712),
  [#19599](https://github.com/google-gemini/gemini-cli/issues/19599)). This is a
  tool-**availability** bug, **not** a confirmed hook bypass — don't overstate
  it. Whether `BeforeTool` fires for a _successfully loaded_ subagent's tool
  calls is undocumented (unknown).
- **[G4] resumed ❓** — no source on resumed-session hook behavior. Unknown.

### In-process hosts we researched but are not yet shipping adapters for

Both fit `IN_PROCESS`, both surfaced coverage holes worth carrying into the
matrix once/if adapters land (full detail in `schema-fit.md` §OpenHands,
§Goose):

- **OpenHands** — one shared confirmation path gates builtin + MCP `ActionEvent`s
  as a batch, **but**: (a) `conversation.execute_tool()` **bypasses** the
  analyzer and confirmation policy entirely — a call on that path emits no
  `ToolCallEvent` (sub-shape 2, un-vetoable); (b) read-only-annotated tools
  short-circuit to `SecurityRisk.UNKNOWN` before the analyzer runs, so a
  spoofable `readOnlyHint` on an MCP tool sidesteps analysis; (c) sub-agent /
  delegate inheritance of the security analyzer is **unconfirmed** — flag, don't
  assume. [OpenHands security](https://docs.all-hands.dev/) and
  `schema-fit.md` §OpenHands(d).
- **Goose** — a single `ToolInspector` gate covers builtin **and** MCP/extension
  tools (confirmed from source; not two gates). But `GooseMode::Auto` (the
  `#[default]`, and the mode headless/scheduled sessions run in)
  unconditionally returns `InspectionAction::Allow` in the built-in
  `PermissionInspector` ⇒ **every** call under Auto is `this_call_vetoable:
false`. Subagents get their own `Agent` (own gate) but "only spawn under
  Auto," so their calls are never human-gated in practice.
  [`schema-fit.md` §Goose(d)];
  [block/goose#7915](https://github.com/block/goose/pull/7915).

## So what

**Confirmed `this_call_vetoable: false` today — adapters MUST mark these (or the
event never arrives), and a monitor MUST degrade `deny → notify`:**

- opencode **MCP-server tool** calls — #2319 (event never parsed).
- Codex **MCP-server tool** calls **and non-Bash builtins** (`apply_patch`,
  Read/Edit/Write, web fetch) — hook fires for Bash only.
- Gemini CLI **any call when the host is < v0.26.0** — no hook surface exists.
- Goose **any call under Auto mode**; OpenHands calls made via
  `execute_tool()` or shielded by a `readOnlyHint` — for the in-process hosts,
  once adapters exist.

**Unknown — needs a live-conformance probe (item ⑤) before an adapter may mark
the class vetoable:**

- opencode **subagent** firing (its MCP gap is reason for suspicion, not proof).
- Gemini CLI **MCP** firing (upgrade medium→confirmed), **subagent** firing for
  a successfully loaded agent, and **resumed-session** firing.
- Amp **resumed-session** firing (structural argument is strong but uncited).
- OpenHands sub-agent security-layer inheritance.

**How far the ❓-is-❌ rule actually reaches today:** an adapter applies its
coverage row through `classifyCallClass`, which returns `mcp` (tool name or
`mcp_context`), then `subagent` (a non-empty `agent_type` on the payload), else
`builtin`. MCP is checked first: an MCP call made inside a subagent still goes
out through the host's MCP surface, the axis most often left un-gated.

So the **subagent** row bites exactly on the hosts that stamp that field. Claude
Code does, on every hook input ([C3]) — and its cells are ✅, so nothing changes
there. Codex does too, contrary to what the docs and
[openai/codex#16226](https://github.com/openai/codex/issues/16226) (open) still
say: the item-⑤ probe behind [X3] read `agent_type=default` and an `agent_id`
matching `SubagentStart`'s off a subagent's `PreToolUse` payload, and
`agent_type=absent` off the main thread's — the absence is what makes the field
a discriminator. Gemini CLI documents no such field, so [G3] is still waiting on
a probe; the wiring is in place, and the row answers the day the payload names
an agent.

The **resumed** row has no signal on any host — a resumed Codex session
announces itself on `SessionStart` (`source: "resume"`, per [X4]'s probe), not
on its tool payloads, and `parse` keeps no cross-event state — so it stays
documentation. Honouring it would mean taking the minimum status across the
classes the classifier cannot separate, which collapses `builtin` to ❓ and
disables enforcement for those adapters outright.

**The risk of assuming coverage a host doesn't provide:** if an adapter reports
`this_call_vetoable: true` for a class the host never routes through the hook,
the monitor is free to render `deny` as `enforced` — and nothing enforces it.
The user is handed a **false assurance**: the transcript shows a block that never
happened while the tool ran anyway. That is strictly worse than a correctly
degraded `notify`, because it suppresses the operator's own reaction. This is
precisely the failure `this_call_vetoable` exists to prevent, and precisely why
a coverage matrix belongs in conformance: shape-conformance (does `render`
produce the right bytes?) says nothing about whether those bytes ever get a
chance to run. A ❓ cell must be treated as ❌ (degrade to notify) until a probe
proves ✅ — defaulting unknown to vetoable is the fail-open the whole mechanism
is built to close.

**Coverage is only one of the two axes, and the other one shipped broken.** A cell answers whether the hook fires for a CLASS of call; it says nothing about whether the host honours a deny on a given EVENT. `classifyCallClass` has no "I cannot tell" answer, so an event no adapter models fell through to `builtin` and inherited that class's ✅ — and Codex routes every non-`PreToolUse` event into `EventKind.UNKNOWN` today, so this was its ordinary path rather than hypothetical drift. Each adapter now declares a `GATED_EVENTS` set beside its `COVERAGE` map, `EventKind.UNKNOWN` is excluded from the gateable set by construction, and conformance rule ⑨ drifts each adapter with an event name no host emits and refuses a vetoable answer.

**A third axis: whether a verdict's CONTENT reaches the model.** Both axes above are about stopping a call. A verdict also carries `mutated_input`, `mutated_output` and `additional_context`, and a host that has no native channel for one drops it — Gemini and Codex document no output-rewrite field, Amp has no stdout body at all. Dropped silently, a redaction verdict renders a bare allow and the unredacted output reaches the model. Each adapter now declares its drops per event kind in `UNRENDERED_FIELDS`, and conformance rule ⑩ holds the declaration to what `render` emits in both directions.

---

**Confidence / provenance notes.** Claude Code, Amp, opencode-#2319, Gemini
version-gate, and both in-process hosts rest on primary docs / issue trackers /
source reads (the last two via `schema-fit.md`). The **Codex Bash-only /
MCP-excluded** coverage claim is corroborated by a third-party reference and
OpenAI's own hooks docs but was **not** reproduced against a live Codex here —
treat as medium confidence and the first thing a probe should verify, since it
drives the largest confirmed un-vetoable surface in the matrix. Every ❓ is
undocumented as of this writing, not inferred.
