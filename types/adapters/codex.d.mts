/**
 * True when `version` ("0.135.0") is at or above {@link MIN_ENFORCING_VERSION}.
 * `semver.coerce` normalizes a patch/prerelease/build-tagged version to its
 * release core; anything it can't coerce to a valid version (missing, empty,
 * garbage) yields `null` and is treated as too old — fail closed to advisory.
 *
 * TRUST BOUNDARY (sandbox, not adapter): `version` is read from the hook stdin
 * payload, so a payload that under-reports it downgrades enforcement to advisory
 * (a deny renders exit 0). The adapter cannot distinguish a spoofed version from
 * a genuinely old Codex — the ground-truth version lives outside the payload —
 * so anti-spoofing belongs to the sandbox that controls what the hook is fed
 * (the same "pin it from outside" posture the managed-config mount enforces for
 * the hook binary; see docs/monitor-invariants.md §Invariant 1). Coercing an
 * absent/garbage version to enforcing HERE would break the legitimate old-Codex
 * case (rendering an exit-2 block a pre-0.135 Codex ignores, while dishonestly
 * marking it `enforced`), so the adapter stays faithful to what the payload says.
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
/** @typedef {import("../control-plane.mjs").NativeResponse} NativeResponse */
export const AGENT: "codex";
export const INTEGRATION_MODE: "external_hook";
/**
 * Hook-coverage matrix row (`docs/hook-coverage-matrix.md`). `PreToolUse`
 * intercepts the shell (Bash) tool ONLY — other builtins and MCP tools never
 * reach it — so builtin is PARTIAL and MCP is UNCOVERED. Subagent and resumed
 * firing are undocumented ⇒ UNKNOWN (treated as uncovered until an item-⑤ probe
 * proves otherwise).
 */
/** @type {import("../control-plane.mjs").CoverageMap} */
export const COVERAGE: import("../control-plane.mjs").CoverageMap;
/**
 * Which {@link VERDICT_CONTENT_FIELDS} have no native channel, so `render`
 * drops them. Codex documents one content channel, `updatedInput` on
 * PreToolUse. It documents no PostToolUse output-rewrite field and no context
 * injection field at all, so `mutated_output` and `additional_context` are
 * dropped on every kind — the same gap `reason` has on Amp. A redaction verdict
 * therefore does NOT reach the model here: the unredacted output stands, and a
 * guardrail that must redact has to deny the call instead. Inventing a native
 * key would be worse than the visible gap, because the host ignores it and the
 * caller reads the render as a redaction applied.
 * @type {Record<string, ReadonlySet<string>|undefined>}
 */
export const UNRENDERED_FIELDS: Record<string, ReadonlySet<string> | undefined>;
/** Minimum Codex version whose hook can actually veto a tool call. */
export const MIN_ENFORCING_VERSION: readonly number[];
/**
 * The native event a conformance probe should carry for each kind — this
 * adapter's own answer, so an every-kind probe exercises the branch that kind
 * really takes. Codex routes every other native event into `unknown`, which has
 * no native name, so `pre_tool` is the only row.
 * @type {Record<string, string|undefined>}
 */
export const NATIVE_EVENT_FOR: Record<string, string | undefined>;
export const DEFAULT_DENY_REASON: "blocked by monitor";
/** @type {import("../control-plane.mjs").Adapter} */
export const codexAdapter: import("../control-plane.mjs").Adapter;
export type ToolCallEvent = import("../control-plane.mjs").ToolCallEvent;
export type Verdict = import("../control-plane.mjs").Verdict;
export type NativeResponse = import("../control-plane.mjs").NativeResponse;
