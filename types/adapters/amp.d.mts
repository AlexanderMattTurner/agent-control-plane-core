/**
 * @param {any} native
 * @returns {ToolCallEvent}
 */
export function parse(native: any): ToolCallEvent;
/**
 * Render into Amp's pure exit-code transport: the decision is the exit code,
 * with no stdout body. An ENFORCED deny also carries its `reason` on
 * `NativeResponse.stderr`, which `emit` writes to fd 2: the delegate is a PATH
 * helper whose stderr Amp surfaces, and this render is what that helper writes,
 * so a block that reached the user with no rationale was the adapter throwing
 * the reason away. Only the enforced path — a deny this call cannot veto and an
 * ask have blocked nothing, and `stderr` is the contract's block-reason channel.
 * No `soleGate` option — an allow already renders as exit 0 either way, so
 * there's no distinct "real approve" signal for this transport to opt into.
 * @param {Verdict} verdict
 * @param {ToolCallEvent} event
 * @returns {NativeResponse}
 */
export function render(verdict: Verdict, event: ToolCallEvent): NativeResponse;
/** @typedef {import("../control-plane.mjs").ToolCallEvent} ToolCallEvent */
/** @typedef {import("../control-plane.mjs").Verdict} Verdict */
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
 * The native event a conformance probe should carry for each kind — this
 * adapter's own answer, so an every-kind probe exercises the branch that kind
 * really takes. Amp's observer names every event `delegate` and reaches no
 * other kind.
 * @type {Record<string, string|undefined>}
 */
export const NATIVE_EVENT_FOR: Record<string, string | undefined>;
/**
 * Which {@link VERDICT_CONTENT_FIELDS} have no native channel, so `render`
 * drops them. Amp's transport is the exit code and nothing else — there is no
 * stdout body to carry a replacement input, a replacement output or extra
 * context, so ALL THREE are dropped on every kind. A guardrail that needs any of
 * them cannot use Amp as its only integration. `reason` is not one of them and
 * is NOT dropped: an enforced deny writes it to the helper's stderr, which Amp
 * surfaces (see {@link render}). Built over every
 * {@link EventKind} rather than the one `parse` emits: a row this adapter cannot
 * reach is still the honest answer for a caller that asks.
 * @type {Record<string, ReadonlySet<string>|undefined>}
 */
export const UNRENDERED_FIELDS: Record<string, ReadonlySet<string> | undefined>;
/** @type {import("../control-plane.mjs").Adapter} */
export const ampAdapter: import("../control-plane.mjs").Adapter;
export type ToolCallEvent = import("../control-plane.mjs").ToolCallEvent;
export type Verdict = import("../control-plane.mjs").Verdict;
export type NativeResponse = import("../control-plane.mjs").NativeResponse;
