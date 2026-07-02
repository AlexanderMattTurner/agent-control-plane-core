/**
 * @param {any} native
 * @returns {ToolCallEvent}
 */
export function parse(native: any): ToolCallEvent;
/**
 * Render into Amp's pure exit-code transport: the decision is the exit code,
 * with no stdout body. `reason` has no native channel here, so it is dropped
 * (Amp surfaces the helper's own stderr). No `soleGate` option — an allow
 * already renders as exit 0 either way, so there's no distinct "real approve"
 * signal for this transport to opt into.
 * @param {Verdict} verdict
 * @param {ToolCallEvent} event
 * @returns {NativeResponse}
 */
export function render(verdict: Verdict, event: ToolCallEvent): NativeResponse;
/** @typedef {import("../control-plane.mjs").ToolCallEvent} ToolCallEvent */
/** @typedef {import("../control-plane.mjs").Verdict} Verdict */
/** @typedef {import("../control-plane.mjs").EventMeta} EventMeta */
/** @typedef {import("../control-plane.mjs").NativeResponse} NativeResponse */
export const AGENT: "amp";
export const INTEGRATION_MODE: "external_hook";
/** @type {import("../control-plane.mjs").Adapter} */
export const ampAdapter: import("../control-plane.mjs").Adapter;
export type ToolCallEvent = import("../control-plane.mjs").ToolCallEvent;
export type Verdict = import("../control-plane.mjs").Verdict;
export type EventMeta = import("../control-plane.mjs").EventMeta;
export type NativeResponse = import("../control-plane.mjs").NativeResponse;
