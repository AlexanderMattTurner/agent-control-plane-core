/**
 * True when `version` ("0.135.0") is at or above {@link MIN_ENFORCING_VERSION}.
 * A missing/garbage version is treated as too old (fail closed to advisory).
 * @param {unknown} version
 * @returns {boolean}
 */
export function canEnforce(version: unknown): boolean;
/**
 * Parse a raw Codex hook payload. Never throws on unmodelled input. Marks the
 * event observe-only (this_call_vetoable=false) when the Codex version
 * predates hook enforcement.
 * @param {any} native
 * @returns {ToolCallEvent}
 */
export function parse(native: any): ToolCallEvent;
/**
 * Render into Codex's native external-hook transport: a `hookSpecificOutput`
 * body preserving the native event name (`PreToolUse`/`PermissionRequest`) plus
 * exit 2 on an enforceable deny. On a pre-v0.135 Codex (`this_call_vetoable`
 * false) the body still renders but exit stays 0 and `enforced` is false —
 * advisory only.
 *
 * `soleGate` (default `false`) is the same dangerous, explicit opt-in as the
 * Claude adapter: when `true` AND the verdict is `allow`, the render emits the
 * real `permissionDecision: "allow"` instead of abstaining.
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
export const AGENT: "codex";
export const INTEGRATION_MODE: "external_hook";
/** Minimum Codex version whose hook can actually veto a tool call. */
export const MIN_ENFORCING_VERSION: readonly number[];
/** @type {import("../control-plane.mjs").Adapter} */
export const codexAdapter: import("../control-plane.mjs").Adapter;
export type ToolCallEvent = import("../control-plane.mjs").ToolCallEvent;
export type Verdict = import("../control-plane.mjs").Verdict;
export type EventMeta = import("../control-plane.mjs").EventMeta;
export type NativeResponse = import("../control-plane.mjs").NativeResponse;
