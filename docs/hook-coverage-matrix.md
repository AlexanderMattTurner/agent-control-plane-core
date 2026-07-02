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
Subagent/resumed cells stay advisory-only in code until an item-⑤ probe supplies a
detectable signal — the tables below remain the SSOT for what each cell claims.

## Why "hook fires?" is exactly `this_call_vetoable`

`ToolCallEvent.this_call_vetoable` (`src/control-plane.mjs:140`) is defined as:
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
| **Subagent-spawned tool**     | ✅ [C3]     | ❓ [X3]               | ✅ (context) [A3] | ❓ [O3]         | ⚠️ load-bug [G3]         |
| **Resumed/continued session** | ✅ [C4]     | ❓ [X4]               | ✅ struct. [A4]   | ✅ struct. [O4] | ❓ [G4]                  |

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
Code, version-gated — shipped adapter pins `MIN_ENFORCING_VERSION [0,135]`,
`src/adapters/codex.mjs:36`)

- **[X1] builtin ⚠️ Bash only** — `PreToolUse` "intercepts the shell (Bash) tool
  only — by design." `apply_patch`, Read/Edit/Write, and web fetch do **not**
  fire it, so a hook-only layer never sees a Codex file edit. Medium confidence
  (third-party reference, corroborated below).
  [ACP Codex hooks reference](https://agenticcontrolplane.com/blog/codex-cli-hooks-reference);
  [OpenAI Codex hooks docs](https://developers.openai.com/codex/hooks).
- **[X2] MCP ❌** — MCP tool calls are explicitly outside `PreToolUse` coverage.
  Same sources as [X1]. This is a confirmed un-vetoable class today.
- **[X3] subagent ❓** — subagent/delegation calls are not listed as covered, and
  even if a subagent's calls did reach `PreToolUse`, only its _Bash_ calls would
  (per [X1]). No source confirms firing either way ⇒ unknown, resolve by probe.
- **[X4] resumed ❓** — no source on whether a resumed Codex session re-arms the
  hook surface. Unknown.

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

- Codex **subagent** and **resumed-session** firing.
- opencode **subagent** firing (its MCP gap is reason for suspicion, not proof).
- Gemini CLI **MCP** firing (upgrade medium→confirmed), **subagent** firing for
  a successfully loaded agent, and **resumed-session** firing.
- Amp **resumed-session** firing (structural argument is strong but uncited).
- OpenHands sub-agent security-layer inheritance.

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

---

**Confidence / provenance notes.** Claude Code, Amp, opencode-#2319, Gemini
version-gate, and both in-process hosts rest on primary docs / issue trackers /
source reads (the last two via `schema-fit.md`). The **Codex Bash-only /
MCP-excluded** coverage claim is corroborated by a third-party reference and
OpenAI's own hooks docs but was **not** reproduced against a live Codex here —
treat as medium confidence and the first thing a probe should verify, since it
drives the largest confirmed un-vetoable surface in the matrix. Every ❓ is
undocumented as of this writing, not inferred.
