/**
 * True when `version` ("0.135.0") is at or above {@link MIN_ENFORCING_VERSION}.
 * `semver.coerce` normalizes a patch/prerelease/build-tagged version to its
 * release core; anything it can't coerce to a valid version (missing, empty,
 * garbage) yields `null` and is treated as too old — fail closed to advisory.
 *
 * WHERE THE VERSION COMES FROM: Codex's PreToolUse stdin carries no `version`
 * field, so the launcher that pins the Codex binary supplies it, through
 * {@link createCodexAdapter}. A payload `version` is a fallback only, and the
 * payload is untrusted: one that under-reports downgrades a deny to advisory. Coercing an absent version to enforcing HERE would
 * break the legitimate old-Codex case (an exit-2 block a pre-0.135 Codex
 * ignores, dishonestly marked `enforced`), so an unknown version stays advisory.
 * @param {unknown} version
 * @returns {boolean}
 */
export function canEnforce(version: unknown): boolean;
/**
 * Parse a raw Codex hook payload. Never throws on unmodelled input. Marks the
 * event observe-only (this_call_vetoable=false) when the Codex version
 * predates hook enforcement.
 *
 * `version` is the Codex version the LAUNCHER pinned, and it wins. Codex's
 * hook stdin documents no version field, so a payload `version` is read only
 * when no launcher version was given: a wrapper that injects one into stdin
 * keeps working. With neither, the event is advisory.
 * @param {any} native
 * @param {{ version?: string }} [options]
 * @returns {ToolCallEvent}
 */
export function parse(native: any, { version }?: {
    version?: string;
}): ToolCallEvent;
/**
 * Render into Codex's native external-hook transport: a JSON body preserving the
 * native event name (`PreToolUse`/`PermissionRequest`/`PostToolUse`) plus exit 2
 * on an enforceable deny. On a pre-v0.135 Codex (`this_call_vetoable` false) the
 * body still renders but exit stays 0 and `enforced` is false — advisory only.
 *
 * Each native event gets its OWN shape, because Codex parses each strictly: a
 * PreToolUse decision rides `hookSpecificOutput.permissionDecision`, a
 * PermissionRequest one `hookSpecificOutput.decision.behavior`, and a
 * post-tool one the top-level `decision`/`reason` pair.
 *
 * `soleGate` (default `false`) is the same dangerous, explicit opt-in as the
 * Claude adapter, and acts only on PermissionRequest: there an `allow` renders
 * `behavior: "allow"`, which grants the approval (from 0.166, not when the hook
 * is environment-sourced). PreToolUse has no allow that
 * approves anything (Codex accepts `"allow"` only beside `updatedInput`, as a
 * rewrite), and post-tool there is no approval left to grant.
 * @param {Verdict} verdict
 * @param {ToolCallEvent} event
 * @param {{ soleGate?: boolean }} [options]
 * @returns {NativeResponse}
 */
export function render(verdict: Verdict, event: ToolCallEvent, { soleGate }?: {
    soleGate?: boolean;
}): NativeResponse;
/**
 * Build a Codex adapter whose `parse` judges every payload against `version`,
 * the Codex version the launcher pinned (Codex's hook stdin carries none).
 * Below {@link MIN_ENFORCING_VERSION} every event parses observe-only and a
 * deny renders advisory. With no `version`, `parse` falls back to a payload
 * `version` (see {@link parse}). An option outside {@link OPTION_NAMES} throws,
 * so a misspelled setting is never dropped in silence.
 * @param {{ version?: string }} [options]
 * @returns {import("../control-plane.mjs").Adapter}
 */
export function createCodexAdapter(options?: {
    version?: string;
}): import("../control-plane.mjs").Adapter;
/** @typedef {import("../control-plane.mjs").ToolCallEvent} ToolCallEvent */
/** @typedef {import("../control-plane.mjs").Verdict} Verdict */
/** @typedef {import("../control-plane.mjs").NativeResponse} NativeResponse */
/** @typedef {import("../control-plane.mjs").EventMeta} EventMeta */
export const AGENT: "codex";
export const INTEGRATION_MODE: "external_hook";
/**
 * Hook-coverage matrix row (`docs/hook-coverage-matrix.md`). `PreToolUse` fires
 * for the shell tools, `apply_patch`, every MCP tool call and every other
 * function tool ([X1]/[X2], read from Codex's own source at the enforcement
 * floor). It never fires for `write_stdin`, which types into a process an
 * earlier call started, nor for a tool OpenAI runs on its own side, so builtin
 * and MCP are both PARTIAL. A live probe ([X3]/[X4]) fired `PreToolUse` for a
 * SUBAGENT's call and for a call in a RESUMED session, so both are PARTIAL too.
 *
 * These rows describe PRE-TOOL routing, which is the only thing the matrix's
 * [X1]/[X2] sources speak about. `parse` applies them to a pre-tool event only
 * (see {@link vetoableCall}); a `PostToolUse` payload in hand is proof the
 * post-tool hook fired for that call, whatever the pre-tool row says.
 *
 * The SUBAGENT row is the one the classifier now reaches on this host: the same
 * probe found `agent_id`/`agent_type` present on a subagent's `PreToolUse`
 * payload and ABSENT on the main thread's, so {@link classifyCallClass} answers
 * SUBAGENT from that payload alone. It is PARTIAL, so such a call stays vetoable
 * — the row's job here is to be honest, not to degrade. An MCP-named call takes
 * the MCP row either way, subagent or not.
 *
 * The RESUMED row is DECLARATIVE ONLY, for a reason no longer about coverage: a
 * resumed session announces itself on `SessionStart` (`source: "resume"`), not on
 * its tool payloads, and this package keeps no cross-event state — so the
 * classifier cannot answer RESUMED from a lone pre-tool event and such a call is
 * judged by the row its TOOL selects. Both rows are PARTIAL, so that reads the
 * same either way.
 */
/** @type {import("../control-plane.mjs").CoverageMap} */
export const COVERAGE: import("../control-plane.mjs").CoverageMap;
/**
 * Which {@link VERDICT_CONTENT_FIELDS} have no native channel on each kind's
 * {@link NATIVE_EVENT_FOR} event, so `render` drops them. PreToolUse takes
 * `updatedInput` (applied only beside `permissionDecision: "allow"`) and
 * `additionalContext`; PostToolUse takes `additionalContext` alone ([X8], read
 * at `rust-v0.166.0` and identical at `rust-v0.135.0`). `PermissionRequest`,
 * which also parses as `pre_tool`, takes neither: its schema is
 * `{hookEventName, decision: {behavior, message}}`, and a body carrying
 * `updatedInput` is ignored (Codex's own approval flow decides), so
 * {@link render} drops both there.
 *
 * NEITHER kind can rewrite tool output: PostToolUse "can't undo side effects
 * from a tool that already ran", and Codex rejects `updatedMCPToolOutput`, so
 * `mutated_output` is dropped everywhere. A redaction verdict therefore does NOT
 * reach the model here: the unredacted output stands, and a guardrail that must
 * redact has to deny (post-tool, that blocks the turn rather than un-showing the
 * output). Inventing a native key would be worse than the visible gap, because
 * the host ignores it and the caller reads the render as a redaction applied.
 * @type {Record<string, ReadonlySet<string>|undefined>}
 */
export const UNRENDERED_FIELDS: Record<string, ReadonlySet<string> | undefined>;
/**
 * How Codex's `PreToolUse` hook files a model tool call ([X7], read from
 * Codex's source at `rust-v0.166.0`). A function tool is filed under its flat
 * name (namespace + name) with its parsed arguments by default; these
 * handlers supply their own payload or none:
 * - `exec_command` → `Bash` with `{command: <cmd>}`; arguments Codex cannot
 *   parse as `ExecCommandArgs` file nothing, which this table models only for
 *   a missing or null `cmd` or scalar arguments. Not modelled: other type
 *   errors, and a positional array, which serde reads (`["ls"]` is `cmd: "ls"`).
 * - `apply_patch` (a freeform tool) → `apply_patch` with its raw patch text as
 *   `command`.
 * - `spawn_agent` in the `multi_agent_v1` namespace → `spawn_agent`.
 * - `write_stdin`, code mode's `wait`, and code mode's freeform `exec` → no hook.
 *   These rules assume the named tool owns the name; a client-defined tool
 *   called `wait` with code mode off takes the default payload.
 *   The default payload is function-only, so a freeform extension tool files
 *   nothing too — the mini-language's rule for an unlisted freeform call.
 * NOT MODELLED: Codex files an MCP call as `mcp__<namespace>__<tool>`, with
 * `_` trimmed from the namespace's end and the tool's start (`mcp.rs`
 * `hook_tool_name`), which can differ from the flat name — a rule keyed by
 * one name cannot express that.
 * @type {import("../control-plane.mjs").PreToolFiling}
 */
export const PRE_TOOL_FILING: import("../control-plane.mjs").PreToolFiling;
/**
 * Codex's `PreToolUse` output parser ([X8], `rust-v0.166.0`) deserializes the
 * body into `deny_unknown_fields` structs at both levels: these seven top-level
 * keys (`PreToolUseCommandOutputWire` with its flattened universal fields), and
 * these five in `hookSpecificOutput`. Any other key fails the whole body: the
 * run is marked failed, no block is set, and the call RUNS. A known key can
 * still void the body by its value or combination (`continue: false`, any
 * `stopReason`, `suppressOutput: true`, `decision: "approve"`, `updatedInput`
 * without `permissionDecision: "allow"`), which this declaration does not
 * describe.
 * @type {import("../control-plane.mjs").PreToolResponse}
 */
export const PRE_TOOL_RESPONSE: import("../control-plane.mjs").PreToolResponse;
/** Minimum Codex version whose hook can actually veto a tool call. */
export const MIN_ENFORCING_VERSION: readonly number[];
/**
 * The native event a conformance probe should carry for each kind — this
 * adapter's own answer, so an every-kind probe exercises the branch that kind
 * really takes. `pre_tool` names `PreToolUse` rather than `PermissionRequest`
 * because that is the branch a synthesized probe should take; `unknown` has no
 * native name by definition and is absent.
 * @type {Record<string, string|undefined>}
 */
export const NATIVE_EVENT_FOR: Record<string, string | undefined>;
/**
 * Codex has NO ask tier. Its pre-tool output parser decodes
 * `permissionDecision: "ask"`, classifies it unsupported, sets no block reason
 * and runs the tool — upstream's own unit test for that path is named
 * `unsupported_permission_decision_fails_open` (read at `rust-v0.155.1`, and
 * byte-identical at `rust-v0.151.0`). `PermissionRequest` is no ask tier either:
 * its behavior enum carries allow and deny only. So a verdict of `ask` has no
 * channel here, and {@link render} sends it down the deny path rather than
 * naming a key the host discards.
 */
export const NATIVE_ASK_TIER: false;
/** The launcher option names {@link createCodexAdapter} reads. */
export const OPTION_NAMES: readonly string[];
/**
 * The Codex adapter with no launcher-pinned version. Real Codex sends no
 * version, so every event it sends parses observe-only here. A deployment that
 * runs Codex ≥ v0.135 builds its own with {@link createCodexAdapter}.
 * @type {import("../control-plane.mjs").Adapter}
 */
export const codexAdapter: import("../control-plane.mjs").Adapter;
export type ToolCallEvent = import("../control-plane.mjs").ToolCallEvent;
export type Verdict = import("../control-plane.mjs").Verdict;
export type NativeResponse = import("../control-plane.mjs").NativeResponse;
export type EventMeta = import("../control-plane.mjs").EventMeta;
