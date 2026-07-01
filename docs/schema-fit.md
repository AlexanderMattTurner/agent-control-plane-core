# Schema-fit: mapping OpenHands, Goose, Amp, opencode, and Gemini CLI onto the control-plane contract

> Freeze-gate design doc (patch item ⑥). This is research and a fit verdict, not a
> code change — `SCHEMA_VERSION` stays `1` and no adapters are added here. The
> question this doc answers: does `ToolCallEvent` / `Verdict` / `NativeResponse`
> (as they exist today, post `this_call_vetoable`) fit five more agents
> _unchanged_, or does landing them require a field the schema doesn't have?

## Verdict up front

**Do not freeze yet.** Three of five agents fit unchanged (Amp — already shipped;
opencode; Gemini CLI). The other two both block, for different reasons:
**OpenHands** doesn't fit the schema — its confirmation mechanism is a
stateful, two-call protocol on a long-lived conversation object, not a
stateless `render(verdict, event) -> NativeResponse`. **Goose** fits the
_shape_ of a decision reasonably well, but has no supported extension point
for a host to plug a custom decision-maker into at all — that's an upstream
Goose limitation, not something a schema change here can fix. See §OpenHands
and §Goose for the detail and §Consolidated verdict for the exact ask.

---

## OpenHands

OpenHands is mid-migration: the original monolith (`OpenHands/OpenHands`, née
`All-Hands-AI/OpenHands` née OpenDevin) is being split into a library,
`openhands-sdk` (repo `OpenHands/software-agent-sdk`), that a host process
embeds directly — this is the one that matters for a control-plane adapter,
since it's the actual `IN_PROCESS` integration surface. The legacy monolith's
`SecurityAnalyzer`/`confirmation_mode` (V0) is deprecated and, per a
maintainer-filed bug ([#9154](https://github.com/All-Hands-AI/OpenHands/issues/9154)),
was never reliably synchronous with execution — the analyzer received events
_after_ they'd already run. All findings below are the current V1 SDK unless
marked legacy.

### (a) Native event / trigger

`Agent._requires_user_confirmation` (`openhands-sdk/openhands/sdk/agent/agent.py`)
runs before dispatch and calls
`state.security_analyzer.analyze_pending_actions(action_events)` — a **batch**
of pending `ActionEvent`s, not one call at a time. This maps reasonably onto
`pre_tool`, but batching is a structural mismatch worth flagging: our schema's
`ToolCallEvent` is one call, one verdict; OpenHands decides a whole batch at
once (`any(...)` — if one action in the batch needs confirmation, the _entire
batch_ pauses).

### (b) Data it carries

An `ActionEvent` (tool name + args via `action.action.model_dump()`), plus a
`security_risk` field the LLM is asked to self-annotate on the tool call
(`SecurityRisk`: `UNKNOWN`/`LOW`/`MEDIUM`/`HIGH`). The default analyzer,
`LLMSecurityAnalyzer`, is a pass-through that just reads back what the LLM
claimed about its own action — not an independent judgment. Deterministic
alternatives exist (`PatternSecurityAnalyzer` regex-based,
`PolicyRailSecurityAnalyzer` for composed threats, `EnsembleSecurityAnalyzer` to
combine several and take the worst verdict) and are architecturally closer to
what a `deny-matcher` guardrail in this contract's spirit would want to plug in
as.

### (c) How a decision is communicated back — the actual gap

**No exception is thrown. No value is returned to a caller expecting a
decision.** The mechanism is a state mutation plus an early return:

```python
if any(state.confirmation_policy.should_confirm(risk) for risk in risks):
    state.execution_status = ConversationExecutionStatus.WAITING_FOR_CONFIRMATION
    return True
```

The dispatch loop just stops (`return` inside `_handle_tool_calls`). The pending
actions sit in the event log, un-executed. Resolving them is **a second,
separate call** the host makes later:

```python
if conversation.state.execution_status == ConversationExecutionStatus.WAITING_FOR_CONFIRMATION:
    pending = ConversationState.get_unmatched_actions(conversation.state.events)
    if not approved:
        conversation.reject_pending_actions("reason")   # DENY
        continue
conversation.run()                                        # re-running = ALLOW
```

There is no "ask" primitive distinct from this pause state, and there is no deny
primitive distinct from calling `reject_pending_actions()` — **allow is "call
`run()` again," deny is "call `reject_pending_actions(reason)` instead."** Both
are imperative method calls on a stateful `Conversation` object across a
resumed loop iteration, not a value `render()` can hand back synchronously.

This does not fit any existing `NativeResponse` channel:

- Not `stdout`/`exit_code` — there is no subprocess or serialized JSON.
- Not `throw_` — nothing is thrown; `throw_`'s doc comment describes "a
  thrown-error block signal (plugin transports, e.g. opencode)," which is a
  same-stack-frame synchronous abort. OpenHands's deny is a _later, separate_
  method call after the loop has already paused and control has returned to
  the host.
- Not `fallback` — that channel is for an out-of-band mechanism the adapter
  _additionally_ requires alongside an in-band deny (an external pin, a config
  wildcard); OpenHands has no in-band deny to begin with.

**Conclusion: `render(verdict, event) -> NativeResponse` cannot express an
OpenHands decision as a single synchronous return value**, because "applying a
verdict" here means driving a two-step async protocol (check
`execution_status`, then call one of two methods on a long-lived object) rather
than producing a response body. Fitting OpenHands means either:

1. adding a `NativeResponse` shape for a two-call/stateful protocol (a
   discriminated variant carrying which method to invoke and its argument,
   e.g. `{ transport: "in_process", method: "reject_pending_actions", args: [reason] }`
   vs `{ method: "run" }`), or
2. accepting that some `IN_PROCESS` agents need an `Adapter` that isn't just
   `{ parse, render }` — e.g. an adapter exposing an `apply(verdict, conversation)`
   that performs the two-step protocol itself instead of returning data for the
   caller to apply.

Neither is invented here — this is the "needs field X" this doc exists to
surface, not resolve.

### (d) Known gaps

- **`conversation.execute_tool()` bypasses the analyzer and confirmation policy
  entirely** — documented explicitly in OpenHands's own security guide, not a
  bug report. A caller using this path emits an event this contract has no way
  to mark `this_call_vetoable: false` for, because the event never reaches the
  analyzer at all — it's not that the call is unvetoable, it's that no
  `ToolCallEvent` would ever be constructed for it under a `parse`/`render`
  adapter wired only to the confirmation-policy path.
- **Read-only-annotated tools skip risk-scoring outright** (`read_only_tool`
  short-circuits to `SecurityRisk.UNKNOWN` before the analyzer runs at all) —
  a spoofable `readOnlyHint` on an MCP tool sidesteps analysis with no
  cross-check found.
- Sub-agent/delegate inheritance of `security_analyzer`/`confirmation_policy`
  is **unconfirmed** — the SDK docs describe delegates as inheriting model
  config and workspace context but say nothing explicit about inheriting the
  security layer. Flag, don't assume either way.
- A live bug ([#11309](https://github.com/OpenHands/OpenHands/issues/11309)):
  removing the analyzer while the LLM still emits `security_risk` throws a hard
  `RuntimeError` instead of degrading gracefully — a robustness gap on the
  analyzer on/off transition, not a security bypass.

### (e) Version/config gating

No version gate in the Codex sense (no "hooks only work above vX"). Gating is
purely a configuration choice: `set_security_analyzer(...)` +
`set_confirmation_policy(...)` (`NeverConfirm`/`AlwaysConfirm`/`ConfirmRisky`).
The CLI wraps this as flags: default = ask every action, `--always-approve`/
`--yolo` = `NeverConfirm`, `--llm-approve` = `ConfirmRisky` + `LLMSecurityAnalyzer`.
**Headless mode has no confirmation surface at all** in the legacy monolith's
CLI (deprecated) and maps to `NeverConfirm()` in the new SDK-backed CLI — i.e.
`this_call_vetoable` would be unconditionally `false` for any headless-launched
conversation, matching the Codex pre-v0.135 pattern but gated by a runtime flag
rather than a binary version.

---

## Goose

### (a) Native event / trigger

`ToolInspector` trait (`crates/goose/src/tool_inspection.rs`):

```rust
async fn inspect(&self, session_id: &str, tool_requests: &[ToolRequest],
                  messages: &[Message], goose_mode: GooseMode) -> Result<Vec<InspectionResult>>
```

Invoked from the core agent loop (`crates/goose/src/agents/agent.rs`) via
`ToolInspectionManager::inspect_tools()`, over the **batch** of pending
`ToolRequest`s for a turn, before any of them dispatch. Confirmed directly from
source: **built-in tools and MCP/extension tools share this one gate** — the
kind-specific branch (`dispatch_tool_call`'s special-casing of the schedule
tool, frontend tools, vs. falling through to
`extension_manager.dispatch_tool_call` for MCP tools) happens _after_ a request
has already cleared this inspection, not before. There is exactly one gate, not
a built-in gate plus a separate MCP gate.

### (b) Data it carries

Full session `messages: &[Message]`, the batch of `ToolRequest`s (name +
args), and the current `GooseMode`. `PermissionInspector` (the built-in
implementer) additionally layers MCP `read_only`/`destructive`/`idempotent`
annotations (authoritative when present) and an LLM-based classifier fallback
in `SmartApprove` mode. The result type carries a real decision, not just a
risk label:

```rust
pub enum InspectionAction { Allow, Deny, RequireApproval(Option<String>) }
pub struct InspectionResult { tool_request_id, action, reason, confidence, inspector_name, finding_id }
```

### (c) How a decision is communicated back

Two mechanisms, confirmed from source:

- **Synchronous return** for a decision an inspector can make without a human:
  `inspect()` returns `InspectionAction::{Allow, Deny}` directly, a plain Rust
  value — no channel, no exception.
- **Async human-in-the-loop** for `RequireApproval`: the agent loop registers a
  `tokio::sync::oneshot::Receiver<PermissionConfirmation>` keyed by request ID
  (`ToolConfirmationRouter::register`), yields an `action_required` message to
  the frontend, and **awaits** the paired sender being fulfilled later via
  `ToolConfirmationRouter::deliver(request_id, confirmation)`. A `DenyOnce`/
  `AlwaysDeny`/`Cancel` confirmation does **not** abort the turn — it
  synthesizes an in-band tool-result message ("The user has declined to run
  this tool...") back to the model and the loop continues.

This is a real, if partial, structural match: the synchronous path
(`InspectionAction::Allow`/`Deny`, returned directly) is exactly the shape
`render() -> NativeResponse` wants — a decision as a returned value, not a
side-channel. But it does **not** close the schema gap, for a sharper reason
than "no channel represents a returned value": **there is no supported
extension point to plug a custom decision-maker in at all.**
`Agent::create_tool_inspection_manager()` hardcodes the inspector stack
(`SecurityInspector`, `EgressInspector`, `AdversaryInspector`,
`PermissionInspector`, `RepetitionInspector`) at construction and the field
isn't exposed for a host to call `agent.add_inspector(...)` post-construction.
The _only_ external lever confirmed in source is answering an
already-triggered `RequireApproval` via `ToolConfirmationRouter::deliver` — a
guardrail embedding Goose today can resolve an ask, but cannot independently
escalate an `Allow` the built-in inspectors already decided into a `Deny`, nor
intercept a call none of the built-ins flagged. That is a materially bigger
gap than "the schema has no channel for this" — it's "the host has no seam to
call `parse`/`render` at all," short of forking Goose's source to register an
inspector.

### (d) Known gaps

- **`GooseMode::Auto` is both the coded `#[default]` and the documented
  default for headless/scheduled sessions, and it is unconditional in the
  built-in inspector**: `permission_inspector.rs` — `GooseMode::Auto =>
InspectionAction::Allow` — confirmed directly from source, not inferred. So
  for the shipped `PermissionInspector`, `this_call_vetoable` would be `false`
  for every call under Auto mode, parallel to Codex's pre-v0.135 case except
  gated by a runtime mode, not a binary version. (A hypothetical custom
  inspector _could_ ignore `goose_mode` and still flag `RequireApproval` under
  Auto — but per (c), there is no supported way to register one today.)
- **Subagents get their own `Agent` instance (own gate), not a bypass** —
  `subagent_handler.rs` constructs a fresh `Agent::with_config`, which wires
  the same hardcoded inspector stack. But Goose's own docs state subagents are
  "disabled in manual approval, smart approval, and chat-only modes" and only
  spawn under `Auto` — so in practice, a subagent's tool calls are never
  routed through a human-approval prompt, not because the gate is skipped but
  because subagents only exist in the one mode where the gate auto-allows
  everything.
- A real bug class existed and was fixed, not just documented: a headless
  session in `Approve`/`SmartApprove` mode used to **hang forever** waiting for
  a terminal prompt that could never arrive
  ([#7915](https://github.com/block/goose/pull/7915)). The fix makes it
  **error instead of silently proceeding** — the same "fail loud, not silently
  bypass" instinct this repo's own doctrine follows, worth citing as prior art
  if a future incident-response doc needs one.
- Version history of when confirmation/`GooseMode` was introduced, and whether
  an earlier Goose fully auto-approved with no gate at all, could **not** be
  established (no reachable `CHANGELOG.md`, GitHub code search login-walled,
  release pagination didn't reach far enough back) — flagged as an open
  question, not asserted either way.

### (e) Version/config gating

`GooseMode` (config file or `GOOSE_MODE` env var) is the gate — a runtime
config choice, not a binary-version floor. Per-tool `PermissionConfig`
overrides (`always_allow`/`ask_before`/`never_allow`, persisted in
`permission.yaml`) layer on top and persist across sessions independent of the
session-wide mode.

---

## Amp (re-check)

No new information changes the existing adapter's fit. Amp's transport is a
delegate binary invoked per tool call, decision entirely in the exit code (0
allow / 1 ask / 2 reject, no stdout body) — this is `EXTERNAL_HOOK`, already
shipped, already conformant. Nothing in this research round surfaced a gap in
the shipped adapter.

## opencode (re-check)

**Fits unchanged, and the schema already anticipated it.** `control-plane.mjs`'s
`NativeResponse.throw_` doc comment already names opencode as the reference
case for that channel — this research confirms the mechanism matches exactly:

- Integration: `IN_PROCESS` — plugins are JS/TS modules loaded into the
  opencode process itself (`https://open-code.ai/en/docs/plugins`), not
  subprocesses.
- Native event: `tool.execute.before(input, output)` / `tool.execute.after`.
- Decision: **deny = throw an error; allow = return normally, optionally
  mutating `output`** (maps directly to `mutated_input`). No native "ask"
  primitive was found — an adapter would need to render `ask` as something
  else (deny with a distinguishing reason, most likely), the same kind of
  per-adapter limitation Amp already has for `reason` on deny.
- **Confirmed gap, not just suspected**: MCP-sourced tool calls do **not**
  trigger `tool.execute.before`/`after` at all
  ([sst/opencode#2319](https://github.com/sst/opencode/issues/2319)). An
  opencode adapter's `parse` would set `this_call_vetoable: false` for events
  it can construct from other signals about an MCP call, but in practice this
  event class likely never reaches `parse` in the first place (same shape of
  gap as OpenHands's `execute_tool()` bypass) — worth noting as a pattern that
  recurs across every `IN_PROCESS` agent researched: the plugin/hook surface
  and the MCP-tool surface are frequently wired separately, and the gap shows
  up as "event never parsed" rather than "event parsed with `this_call_vetoable:
false`." No fallback (config-level MCP deny-wildcard) is documented for this
  gap today.

## Gemini CLI (re-check)

**Fits unchanged — same shape as Claude Code/Codex, needs a Codex-style version
gate.**

- Integration: `EXTERNAL_HOOK`. Hooks are subprocess scripts invoked at
  lifecycle points (`BeforeTool`, `AfterTool`, `AfterAgent`), stdin JSON in,
  stdout JSON out (`https://geminicli.com/docs/hooks/reference/`).
- Decision channel, with one wrinkle worth carrying into an adapter: **exit
  code 0** is the normal path even for a _deny_ — stdout is parsed as JSON
  `{"decision": "allow"|"deny", "reason": ...}`. **Exit code 2** is a distinct
  hard-block path (stderr as reason, no JSON parsing) — closer to Claude/Codex's
  exit-2-means-deny convention. **Any other nonzero exit code fails open** — a
  hook crash produces a warning and the tool call proceeds anyway. This is a
  meaningfully different default from Claude Code (where a non-conforming hook
  output has historically been treated conservatively) and must be encoded
  correctly in a future `render()` — an adapter bug that picked a nonstandard
  exit code for `deny` would silently fail open on Gemini CLI.
  MCP tools are named `mcp_<server>_<tool>` and matched the same way as
  built-ins in hook `matcher` patterns, suggesting (medium confidence, not a
  worked example) they route through the same `BeforeTool` hook rather than
  bypassing it the way opencode's MCP tools do.
- **Version gate**: hooks shipped in **v0.26.0+**
  (`https://developers.googleblog.com/tailor-gemini-cli-to-your-workflow-with-hooks/`).
  Pre-0.26 Gemini CLI has no hook surface at all — `observe_only`/no adapter
  possible, not merely non-enforcing — this is a _stricter_ pre-version state
  than Codex's pre-0.135 (which still had _a_ hook, just non-enforcing).
- Known gap: custom subagents (`~/.gemini/agents/`) with MCP tools in their
  tool list fail to load/validate at all
  ([#17005](https://github.com/google-gemini/gemini-cli/issues/17005),
  [#18712](https://github.com/google-gemini/gemini-cli/issues/18712),
  [#19599](https://github.com/google-gemini/gemini-cli/issues/19599)) — a
  tool-availability bug, not a confirmed hook bypass; don't overstate it as the
  latter in a future coverage matrix.

## Codex CLI (re-check against the shipped adapter)

One finding worth flagging back rather than acting on unilaterally: this
research's independent timeline reconstruction (GitHub PRs/issues/releases)
places enforcing `PreToolUse`/`PostToolUse` hooks landing around **v0.117.0**
(released ~March 26, 2026), while the shipped adapter's
`MIN_ENFORCING_VERSION` is pinned to `[0, 135]`
(`src/adapters/codex.mjs:36`). This may be a deliberate conservative pin (wait
for the feature to stabilize past its initial release) rather than a bug — the
research could not independently verify the _exact_ JSON field names in the
v0.117–v0.135 window, only that enforcement-shaped events existed. Surfacing
this for the maintainer's call, not changing the pinned version in this doc.

---

## Consolidated verdict

| Agent       | Integration mode | Decision channel                                                                                                          | Fits `render()` unchanged?                                                                                                                                                                                                                                                                                                                    |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `external_hook`  | `stdout` + `exit_code`                                                                                                    | Yes (shipped)                                                                                                                                                                                                                                                                                                                                 |
| Codex CLI   | `external_hook`  | `stdout` + `exit_code`, version-gated                                                                                     | Yes (shipped); version-pin discrepancy flagged above                                                                                                                                                                                                                                                                                          |
| Amp         | `external_hook`  | `exit_code` only                                                                                                          | Yes (shipped)                                                                                                                                                                                                                                                                                                                                 |
| opencode    | `in_process`     | `throw_` (deny) / return (allow)                                                                                          | **Yes** — schema already names this as `throw_`'s reference case                                                                                                                                                                                                                                                                              |
| Gemini CLI  | `external_hook`  | `stdout` + `exit_code`, version-gated, exit-2-is-hard-block/other-nonzero-fails-open                                      | **Yes** — same shape as Claude/Codex, needs its own version-gate constant and its distinct fail-open-on-crash semantics                                                                                                                                                                                                                       |
| Goose       | `in_process`     | a returned `InspectionAction` value (sync) or a `PermissionConfirmation` delivered later on a oneshot channel (async ask) | **No, but for a different reason than a schema gap** — the decision shape (a returned enum) would fit `render()` reasonably well, but Goose has **no supported extension point** for a host to register a custom decision-maker at all; the only confirmed external lever is answering an already-triggered ask, not deciding what gets asked |
| OpenHands   | `in_process`     | two-call stateful protocol (`run()` vs `reject_pending_actions()`) on a long-lived `Conversation`                         | **No** — needs either a new `NativeResponse` variant for a stateful/two-call protocol, or an `Adapter` shape that isn't just `{ parse, render }`                                                                                                                                                                                              |

**Freeze recommendation: do not freeze.** opencode and Gemini CLI cost nothing —
land whenever. Goose and OpenHands are both genuine blockers, for two distinct
reasons that a freeze-gate should treat separately: OpenHands's blocker is
**schema-shaped** (`NativeResponse` has no variant for a stateful, two-call
protocol) and would be fixed by adding one; Goose's blocker is
**integration-shaped**, not schema-shaped — no `NativeResponse` design fixes the
absence of a place in Goose's own source to plug a decision-maker in. Goose is
not "needs field X," it's "needs an upstream capability that doesn't exist yet"
(a public `Agent::add_inspector`-equivalent, or an accepted upstream patch to
add one) — track it as a Goose-side dependency, not a schema action item.
OpenHands's two options in §OpenHands(c) are handed back for a schema decision,
not resolved here.
