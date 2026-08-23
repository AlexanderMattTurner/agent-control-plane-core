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
/**
 * Hook-coverage matrix row (`docs/hook-coverage-matrix.md`). Every tool call is
 * checked against the permission engine; `amp.mcpPermissions` runs MCP tools
 * through the same rule syntax, and a rule's `context: "subagent"` selector
 * gates calls inside subagents — so builtin, MCP, and subagent are all COVERED.
 * Resumed-thread firing is a strong-but-uncited structural argument, so it is
 * held at UNKNOWN until an item-⑤ probe confirms it.
 */
/** @type {import("../control-plane.mjs").CoverageMap} */
export const COVERAGE: import("../control-plane.mjs").CoverageMap;
/**
 * Which {@link VERDICT_CONTENT_FIELDS} have no native channel, so `render`
 * drops them. Amp's transport is the exit code and nothing else — there is no
 * stdout body to carry a replacement input, a replacement output or extra
 * context, so ALL THREE are dropped on every kind, the same gap `reason` has
 * here (Amp surfaces the helper's own stderr instead). A guardrail that needs
 * any of them cannot use Amp as its only integration. Built over every
 * {@link EventKind} rather than the one `parse` emits: a row this adapter cannot
 * reach is still the honest answer for a caller that asks.
 * @type {Record<string, ReadonlySet<string>|undefined>}
 */
export const UNRENDERED_FIELDS: Record<string, ReadonlySet<string> | undefined>;
/** @type {import("../control-plane.mjs").Adapter} */
export const ampAdapter: import("../control-plane.mjs").Adapter;
export type ToolCallEvent = import("../control-plane.mjs").ToolCallEvent;
export type Verdict = import("../control-plane.mjs").Verdict;
export type EventMeta = import("../control-plane.mjs").EventMeta;
export type NativeResponse = import("../control-plane.mjs").NativeResponse;
