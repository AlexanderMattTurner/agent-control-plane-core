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
 * Render into Codex's native external-hook transport: a JSON body preserving the
 * native event name (`PreToolUse`/`PermissionRequest`/`PostToolUse`) plus exit 2
 * on an enforceable deny. On a pre-v0.135 Codex (`this_call_vetoable` false) the
 * body still renders but exit stays 0 and `enforced` is false — advisory only.
 *
 * The two kinds use DIFFERENT native shapes, because Codex does: a pre-tool
 * decision rides `hookSpecificOutput.permissionDecision`, a post-tool one the
 * top-level `decision`/`reason` pair (`permissionDecision` is accepted but inert
 * on PostToolUse, so emitting it there would read as a block that never bites).
 *
 * `soleGate` (default `false`) is the same dangerous, explicit opt-in as the
 * Claude adapter: when `true` AND the verdict is `allow`, the render emits the
 * real `permissionDecision: "allow"` instead of abstaining. It has no meaning
 * post-tool — there is no approval left to grant — so it is ignored there.
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
/** @typedef {import("../control-plane.mjs").EventMeta} EventMeta */
export const AGENT: "codex";
export const INTEGRATION_MODE: "external_hook";
/**
 * Hook-coverage matrix row (`docs/hook-coverage-matrix.md`). `PreToolUse`
 * intercepts the shell (Bash) tool ONLY — other builtins and MCP tools never
 * reach it — so builtin is PARTIAL and MCP is UNCOVERED. Subagent and resumed
 * firing are undocumented ⇒ UNKNOWN.
 *
 * These rows describe PRE-TOOL routing, which is the only thing the matrix's
 * [X1]/[X2] sources speak about. `parse` applies them to a pre-tool event only
 * (see {@link vetoableCall}); Codex's `PostToolUse` fires for tools `PreToolUse`
 * never sees, so a post-tool event judged by the MCP row would drop a block
 * Codex documents it honours.
 *
 * The SUBAGENT and RESUMED rows are DECLARATIVE ONLY: a lone Codex pre-tool
 * payload carries no signal for either class, so {@link classifyCallClass}
 * never returns them and `parse` never reads these two entries — a subagent's
 * shell call is classified BUILTIN and judged by the PARTIAL row, i.e. parses
 * vetoable (an MCP-named one still takes the UNCOVERED MCP row). They record the
 * matrix verdict for a consumer reading COVERAGE directly; they become
 * load-bearing only once an item-⑤ probe supplies a classifier signal.
 */
/** @type {import("../control-plane.mjs").CoverageMap} */
export const COVERAGE: import("../control-plane.mjs").CoverageMap;
/**
 * Which {@link VERDICT_CONTENT_FIELDS} have no native channel on each kind, so
 * `render` drops them. Codex splits its two content channels by event:
 * `updatedInput` exists only on PreToolUse (the call has not run yet), and
 * `hookSpecificOutput.additionalContext` only on PostToolUse — Codex documents
 * no context field on PreToolUse, where `updatedInput` is the whole surface.
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
export const DEFAULT_DENY_REASON: "blocked by monitor";
/** @type {import("../control-plane.mjs").Adapter} */
export const codexAdapter: import("../control-plane.mjs").Adapter;
export type ToolCallEvent = import("../control-plane.mjs").ToolCallEvent;
export type Verdict = import("../control-plane.mjs").Verdict;
export type NativeResponse = import("../control-plane.mjs").NativeResponse;
export type EventMeta = import("../control-plane.mjs").EventMeta;
