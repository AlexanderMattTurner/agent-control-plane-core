/**
 * Parse a raw Gemini CLI hook payload into a normalized {@link ToolCallEvent}.
 * Never throws on an unmodelled event type or tool-input field. A payload comes
 * from a hooks-capable Gemini (v0.26.0+) whose `BeforeTool` can pre-empt builtin
 * tools via exit 2. But MCP firing is only medium-confidence (COVERAGE.mcp is
 * UNKNOWN), so an MCP-sourced call — flagged by `mcp_context` or an `mcp_`-named
 * tool — parses non-vetoable until an item-⑤ probe confirms the hook fires.
 * `BeforeAgent` (fires after the user submits a prompt, before planning) maps to
 * `prompt_submit`: no tool, the submitted text folded into `input.prompt`.
 * @param {any} native
 * @returns {ToolCallEvent}
 */
export function parse(native: any): ToolCallEvent;
/**
 * Render into Gemini CLI's native external-hook transport. An enforceable deny
 * renders as exit 2 (the System Block on BeforeTool; documented on BeforeAgent
 * as "same as decision: deny" — it aborts the turn); everything else exits 0
 * with a JSON decision body (or none, when `allow` abstains). `soleGate`
 * (default false) is the same dangerous opt-in as the other adapters: it makes
 * an `allow` emit the real `decision: "allow"` instead of abstaining (tool
 * events only — BeforeAgent documents no allow behavior to opt into).
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
export const AGENT: "gemini";
export const INTEGRATION_MODE: "external_hook";
/**
 * Hook-coverage matrix row (`docs/hook-coverage-matrix.md`). `BeforeTool` gates
 * builtins on v0.26+ (COVERED). MCP routing through the same matcher is only
 * MEDIUM-confidence and unproven, subagent firing for a loaded agent is
 * undocumented, and resumed-session behavior has no source — all three are
 * UNKNOWN, held at fail-closed until an item-⑤ probe upgrades them. A guessed ✅
 * here would be a silent fail-open.
 */
/** @type {import("../control-plane.mjs").CoverageMap} */
export const COVERAGE: import("../control-plane.mjs").CoverageMap;
/** Gemini CLI native hook event names (the `hook_event_name` field). */
export const HookEvent: Readonly<{
    BEFORE_TOOL: "BeforeTool";
    AFTER_TOOL: "AfterTool";
    BEFORE_AGENT: "BeforeAgent";
}>;
/** @type {import("../control-plane.mjs").Adapter} */
export const geminiAdapter: import("../control-plane.mjs").Adapter;
export type ToolCallEvent = import("../control-plane.mjs").ToolCallEvent;
export type Verdict = import("../control-plane.mjs").Verdict;
export type EventMeta = import("../control-plane.mjs").EventMeta;
export type NativeResponse = import("../control-plane.mjs").NativeResponse;
