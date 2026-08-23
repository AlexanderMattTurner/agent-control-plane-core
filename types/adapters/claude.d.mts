/**
 * Parse a raw Claude Code hook payload into a normalized {@link ToolCallEvent}.
 * Never throws on an unmodelled event type or tool-input field.
 * @param {any} native
 * @returns {ToolCallEvent}
 */
export function parse(native: any): ToolCallEvent;
/**
 * Render into Claude Code's native external-hook transport: a
 * `hookSpecificOutput` JSON body on stdout plus the exit code that carries the
 * decision (deny ⇒ exit 2). A deny only counts as `enforced` when the event's
 * `this_call_vetoable` holds.
 *
 * `soleGate` (default `false`) is a dangerous, explicit opt-in: when `true` AND
 * the verdict is `allow`, the render emits Claude Code's REAL
 * `permissionDecision: "allow"`, which bypasses the native permission prompt.
 * Default behavior always abstains on allow (see {@link gatingBody}) so the
 * guardrail can never silently become the sole gate by accident.
 * @param {Verdict} verdict
 * @param {ToolCallEvent} event
 * @param {{ soleGate?: boolean }} [options]
 * @returns {NativeResponse}
 */
export function render(verdict: Verdict, event: ToolCallEvent, { soleGate }?: {
    soleGate?: boolean;
}): NativeResponse;
/** @typedef {import("../control-plane.mjs").ToolCallEvent} ToolCallEvent */
/** @typedef {import("../control-plane.mjs").Verdict} Verdict */
/** @typedef {import("../control-plane.mjs").EventMeta} EventMeta */
/** @typedef {import("../control-plane.mjs").NativeResponse} NativeResponse */
/** Producing-agent id stamped onto every event this adapter parses. */
export const AGENT: "claude";
/** How this adapter attaches to the agent. */
export const INTEGRATION_MODE: "external_hook";
/**
 * Hook-coverage matrix row (`docs/hook-coverage-matrix.md`). `PreToolUse` fires
 * for builtins, for MCP tools (surfaced as `mcp__<server>__<tool>` through the
 * same hook), and for every tool a subagent uses (subagents do not inherit the
 * parent's permissions, so the hook is often their only gate). Resumed sessions
 * re-read hooks from settings and fire per new call — structural, uncontested.
 */
/** @type {import("../control-plane.mjs").CoverageMap} */
export const COVERAGE: import("../control-plane.mjs").CoverageMap;
/**
 * Which {@link VERDICT_CONTENT_FIELDS} have no native channel on each event
 * kind, so `render` drops them. Claude Code splits its content channels by
 * event: `updatedInput` exists only on PreToolUse (the call has not run yet),
 * and `updatedToolOutput` only on PostToolUse (there is no tool output to
 * replace anywhere else). `additionalContext` is the one channel every kind
 * carries. The conformance harness holds this to what `render` actually emits,
 * in both directions.
 *
 * `additionalContext` on PreToolUse is inherited behaviour, not a checked claim:
 * Claude Code documents the field for UserPromptSubmit, SessionStart and
 * PostToolUse, and this adapter has emitted it on PreToolUse since before the
 * declaration existed. Rule ⑩ can see that the value reaches the wire, never
 * that the host reads the key — confirm it against the hook reference before
 * relying on it.
 * @type {Record<string, ReadonlySet<string>|undefined>}
 */
export const UNRENDERED_FIELDS: Record<string, ReadonlySet<string> | undefined>;
/** Claude Code native hook event names (the `hook_event_name` field). */
export const HookEvent: Readonly<{
    PRE_TOOL_USE: "PreToolUse";
    POST_TOOL_USE: "PostToolUse";
    USER_PROMPT_SUBMIT: "UserPromptSubmit";
    SESSION_START: "SessionStart";
}>;
/**
 * The native event a conformance probe should carry for each kind — this
 * adapter's own answer, so an every-kind probe exercises the branch that kind
 * really takes. `unknown` has no native name by definition and is absent.
 * @type {Record<string, string>}
 */
export const NATIVE_EVENT_FOR: Record<string, string>;
/** @type {import("../control-plane.mjs").Adapter} */
export const claudeAdapter: import("../control-plane.mjs").Adapter;
export type ToolCallEvent = import("../control-plane.mjs").ToolCallEvent;
export type Verdict = import("../control-plane.mjs").Verdict;
export type EventMeta = import("../control-plane.mjs").EventMeta;
export type NativeResponse = import("../control-plane.mjs").NativeResponse;
