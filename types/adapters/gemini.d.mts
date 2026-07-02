/**
 * Parse a raw Gemini CLI hook payload into a normalized {@link ToolCallEvent}.
 * Never throws on an unmodelled event type or tool-input field. Any payload we
 * receive comes from a hooks-capable Gemini (v0.26.0+) whose `BeforeTool` can
 * pre-empt via exit 2, so `this_call_vetoable` is true.
 * @param {any} native
 * @returns {ToolCallEvent}
 */
export function parse(native: any): ToolCallEvent;
/**
 * Render into Gemini CLI's native external-hook transport. An enforceable deny
 * renders as exit 2 (the System Block); everything else exits 0 with a JSON
 * decision body (or none, when `allow` abstains). `soleGate` (default false) is
 * the same dangerous opt-in as the other adapters: it makes an `allow` emit the
 * real `decision: "allow"` instead of abstaining.
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
/** Gemini CLI native hook event names (the `hook_event_name` field). */
export const HookEvent: Readonly<{
    BEFORE_TOOL: "BeforeTool";
    AFTER_TOOL: "AfterTool";
}>;
/** @type {import("../control-plane.mjs").Adapter} */
export const geminiAdapter: import("../control-plane.mjs").Adapter;
export type ToolCallEvent = import("../control-plane.mjs").ToolCallEvent;
export type Verdict = import("../control-plane.mjs").Verdict;
export type EventMeta = import("../control-plane.mjs").EventMeta;
export type NativeResponse = import("../control-plane.mjs").NativeResponse;
