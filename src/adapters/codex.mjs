/**
 * The Codex CLI adapter — EXTERNAL_HOOK translator (≥ v0.135).
 *
 * Real Codex speaks nearly the same protocol as Claude Code: `PreToolUse`,
 * `PermissionRequest` and `PostToolUse` hook events with
 * `tool_name`/`tool_input`/`tool_response`, a pre-tool deny expressed as
 * `hookSpecificOutput.permissionDecision = "deny"` plus exit 2, and a post-tool
 * block as top-level `decision: "block"` plus exit 2.
 * Managed pin: /etc/codex/requirements.toml + allow_managed_hooks_only.
 *
 * VERSION GATE: hook enforcement only exists in v0.135+. Below that, there is no
 * veto, so parse marks the event OBSERVE_ONLY with this_call_vetoable=false —
 * the adapter must not pretend to enforce on an old Codex.
 */

import semver from "semver";

import {
  EventKind,
  Decision,
  IntegrationMode,
  CallClass,
  CoverageStatus,
  classifyCallClass,
  vetoableFor,
  assertGatedKinds,
  canonicalTool,
  lookup,
  makeEvent,
  normalizeVerdict,
  nativeResponse,
  UNRENDERED_ON_UNKNOWN,
  readonlySet,
  baseMeta,
  asObject,
  asString,
  asStringOrNull,
} from "../control-plane.mjs";

/** @typedef {import("../control-plane.mjs").ToolCallEvent} ToolCallEvent */
/** @typedef {import("../control-plane.mjs").Verdict} Verdict */
/** @typedef {import("../control-plane.mjs").NativeResponse} NativeResponse */
// Re-exported on this subpath even though no signature below names it:
// tsc turns each @typedef into an `export type` in the generated .d.mts,
// so dropping this line breaks `import type { EventMeta } from "…/<agent>"`
// for every TypeScript consumer.
/** @typedef {import("../control-plane.mjs").EventMeta} EventMeta */

export const AGENT = "codex";
export const INTEGRATION_MODE = IntegrationMode.EXTERNAL_HOOK;

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
export const COVERAGE = Object.freeze({
  [CallClass.BUILTIN]: CoverageStatus.PARTIAL,
  [CallClass.MCP]: CoverageStatus.UNCOVERED,
  [CallClass.SUBAGENT]: CoverageStatus.UNKNOWN,
  [CallClass.RESUMED]: CoverageStatus.UNKNOWN,
});

/**
 * The event kinds this host can actually gate. `PreToolUse`/`PermissionRequest`
 * take a `permissionDecision: "deny"`; `PostToolUse` takes a top-level
 * `decision: "block"` (exit 2 "writes the feedback reason to stderr and blocks
 * further processing"), so a post-tool deny stops the turn even though the tool
 * itself already ran — the same shape the Claude adapter gates. Every other
 * native event parses as UNKNOWN, so without this set each of them reported an
 * enforced block. A kind absent here parses non-vetoable, so an unmodelled event
 * never renders as an enforced block the host will not perform. Module-private:
 * `Object.freeze` does not stop `Set.add`, so an exported set would let a
 * consumer add UNKNOWN back after `assertGatedKinds` has already run.
 */
const GATED_EVENTS = Object.freeze(
  new Set([EventKind.PRE_TOOL, EventKind.POST_TOOL]),
);
assertGatedKinds(GATED_EVENTS, AGENT);

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
export const UNRENDERED_FIELDS = Object.freeze({
  ...Object.fromEntries(
    Object.values(EventKind).map((kind) => [kind, UNRENDERED_ON_UNKNOWN]),
  ),
  [EventKind.PRE_TOOL]: readonlySet(["mutated_output", "additional_context"]),
  [EventKind.POST_TOOL]: readonlySet(["mutated_input", "mutated_output"]),
});

/** Minimum Codex version whose hook can actually veto a tool call. */
export const MIN_ENFORCING_VERSION = Object.freeze([0, 135]);

/** {@link MIN_ENFORCING_VERSION} as the semver string the gate compares against. */
const MIN_ENFORCING_SEMVER = `${MIN_ENFORCING_VERSION[0]}.${MIN_ENFORCING_VERSION[1]}.0`;

/**
 * Codex native hook event names (the `hook_event_name` field) this adapter
 * models. Module-private: the barrel already exports a `HookEvent` (Claude
 * Code's), and nothing outside this file needs a second one — `NATIVE_EVENT_FOR`
 * is the exported answer for which native event a kind carries.
 */
const HookEvent = Object.freeze({
  PRE_TOOL_USE: "PreToolUse",
  PERMISSION_REQUEST: "PermissionRequest",
  POST_TOOL_USE: "PostToolUse",
});

/**
 * Native event name → normalized {@link EventKind}. `PreToolUse` and
 * `PermissionRequest` both gate a tool call before it runs (PermissionRequest is
 * the ask-tier veto), so both normalize to `pre_tool`. Codex emits more events
 * than these — SessionStart/SessionEnd/Stop/PreCompact/… — and every one of them
 * still routes to `unknown`: this adapter models an event only once its host
 * response is established, and an unmodelled event parses non-vetoable.
 */
const NATIVE_TO_KIND = Object.freeze({
  [HookEvent.PRE_TOOL_USE]: EventKind.PRE_TOOL,
  [HookEvent.PERMISSION_REQUEST]: EventKind.PRE_TOOL,
  [HookEvent.POST_TOOL_USE]: EventKind.POST_TOOL,
});

/**
 * The native event a conformance probe should carry for each kind — this
 * adapter's own answer, so an every-kind probe exercises the branch that kind
 * really takes. `pre_tool` names `PreToolUse` rather than `PermissionRequest`
 * because that is the branch a synthesized probe should take; `unknown` has no
 * native name by definition and is absent.
 * @type {Record<string, string|undefined>}
 */
export const NATIVE_EVENT_FOR = Object.freeze({
  [EventKind.PRE_TOOL]: HookEvent.PRE_TOOL_USE,
  [EventKind.POST_TOOL]: HookEvent.POST_TOOL_USE,
});

// Codex drops an enforced deny that carries no (or an empty) reason and runs the
// tool, so a reasonless enforced deny still renders a non-empty one.
export const DEFAULT_DENY_REASON = "blocked by monitor";

// The STANDARD_META_FIELDS are consumed by `baseMeta`, not listed here.
const CONSUMED = new Set([
  "hook_event_name",
  "tool_name",
  "tool_input",
  "tool_response",
  "version",
]);

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
export function canEnforce(version) {
  const coerced = semver.coerce(asString(version, ""));
  if (coerced === null) return false;
  return semver.gte(coerced, MIN_ENFORCING_SEMVER);
}

/**
 * Whether an event of `kind` may be marked vetoable, given the tool it names.
 *
 * PRE_TOOL takes the coverage floor: `PreToolUse` fires for Bash only, so an
 * MCP-sourced call is un-vetoable regardless of version (COVERAGE.mcp).
 *
 * POST_TOOL does NOT, and that is deliberate: {@link COVERAGE} records which
 * calls reach `PreToolUse`, and a `PostToolUse` payload in hand is proof the
 * post-tool hook already fired for this call — Codex documents PostToolUse
 * firing for tools (apply_patch, MCP) that `PreToolUse` never sees. Judging it
 * by the pre-tool MCP row would degrade a block Codex honours to a notify,
 * which is a fail-CLOSED error but still a wrong one. It stays gated on
 * GATED_EVENTS and on the version floor, so nothing here can mark an unmodelled
 * or pre-0.135 event vetoable.
 * @param {string} kind an {@link EventKind} value
 * @param {string|null} nativeTool
 * @param {Record<string, unknown>} raw the native payload, for `mcp_context`
 * @returns {boolean}
 */
function vetoableCall(kind, nativeTool, raw) {
  if (kind === EventKind.POST_TOOL) return GATED_EVENTS.has(kind);
  return vetoableFor(
    kind,
    GATED_EVENTS,
    COVERAGE[classifyCallClass(nativeTool, raw)],
  );
}

/**
 * Parse a raw Codex hook payload. Never throws on unmodelled input. Marks the
 * event observe-only (this_call_vetoable=false) when the Codex version
 * predates hook enforcement.
 * @param {any} native
 * @returns {ToolCallEvent}
 */
export function parse(native) {
  const raw = asObject(native);
  const nativeEvent = asString(raw.hook_event_name, "");
  const kind =
    lookup(
      /** @type {Record<string, string>} */ (NATIVE_TO_KIND),
      nativeEvent,
    ) ?? EventKind.UNKNOWN;
  const enforce = canEnforce(raw.version);

  const meta = baseMeta({
    agent: AGENT,
    native_event: nativeEvent,
    integration_mode: enforce
      ? IntegrationMode.EXTERNAL_HOOK
      : IntegrationMode.OBSERVE_ONLY,
    primary_gate_present: true,
    native: raw,
    consumed: CONSUMED,
  });

  // Classify on the NATIVE name (MCP detection keys on `mcp__…`).
  const nativeTool = asStringOrNull(raw.tool_name);
  if (nativeTool !== null) meta.native_tool = nativeTool;

  return makeEvent({
    event: kind,
    tool: canonicalTool(nativeTool),
    input: asObject(raw.tool_input),
    // `tool_response` is Codex's "tool-specific output" field, PostToolUse only:
    // no other modelled event carries one, and reading it elsewhere would invent
    // a response for a call that has not run.
    response: kind === EventKind.POST_TOOL ? raw.tool_response : undefined,
    this_call_vetoable: enforce && vetoableCall(kind, nativeTool, raw),
    meta,
  });
}

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
export function render(verdict, event, { soleGate = false } = {}) {
  const vd = normalizeVerdict(verdict);
  const enforced = vd.decision === Decision.DENY && event.this_call_vetoable;
  // The native name is preserved rather than derived from the kind, so a
  // PermissionRequest answers as itself; NATIVE_EVENT_FOR names the fallback.
  const hookEventName = event.meta.native_event || HookEvent.PRE_TOOL_USE;

  return nativeResponse({
    transport: event.meta.integration_mode,
    exit_code: enforced ? 2 : 0,
    enforced,
    stdout:
      event.event === EventKind.POST_TOOL
        ? postToolBody(hookEventName, vd, enforced)
        : preToolBody(hookEventName, vd, event, enforced, soleGate),
  });
}

/**
 * The `hookSpecificOutput` body for a pre-tool (or unmodelled) event.
 * @param {string} hookEventName
 * @param {Verdict} vd a normalized verdict
 * @param {ToolCallEvent} event
 * @param {boolean} enforced
 * @param {boolean} soleGate
 * @returns {Record<string, unknown>}
 */
function preToolBody(hookEventName, vd, event, enforced, soleGate) {
  // As in the Claude adapter, `allow` omits permissionDecision by default so the
  // guardrail never auto-approves a call it merely had no objection to; only
  // deny/ask emit an explicit decision, unless `soleGate` opts into it.
  /** @type {Record<string, unknown>} */
  const body = { hookEventName };
  if (vd.decision !== Decision.ALLOW || soleGate) {
    body.permissionDecision = vd.decision;
    if (vd.reason !== undefined) body.permissionDecisionReason = vd.reason;
  }
  // Codex FAILS OPEN on an enforced deny whose permissionDecisionReason is missing
  // or empty: its PreToolUse output parser drops the block (block_reason = None)
  // and runs the tool. Unlike Claude, which honours a bare deny, Codex needs a
  // non-empty reason for the block to bite — so guarantee one on every enforced
  // deny, whatever the judge supplied.
  if (enforced && !body.permissionDecisionReason)
    body.permissionDecisionReason = DEFAULT_DENY_REASON;
  // PRE_TOOL only. An UNKNOWN event reaches this body too, and an event the
  // adapter cannot name has no channel it can claim: emitting `updatedInput`
  // there names a key the host ignores while reading to the caller as a
  // mutation applied.
  if (event.event === EventKind.PRE_TOOL && vd.mutated_input !== undefined)
    body.updatedInput = vd.mutated_input;
  return { hookSpecificOutput: body };
}

/**
 * The body for a PostToolUse event: Codex's documented post-tool schema, a
 * top-level `decision`/`reason` beside a `hookSpecificOutput` carrying
 * `additionalContext`. The tool has already run, so every non-allow verdict —
 * `ask` included, which has no post-tool tier of its own — renders as the one
 * objection the host understands there, `block`.
 * @param {string} hookEventName
 * @param {Verdict} vd a normalized verdict
 * @param {boolean} enforced
 * @returns {Record<string, unknown>}
 */
function postToolBody(hookEventName, vd, enforced) {
  /** @type {Record<string, unknown>} */
  const hookSpecificOutput = { hookEventName };
  if (vd.additional_context !== undefined)
    hookSpecificOutput.additionalContext = vd.additional_context;
  /** @type {Record<string, unknown>} */
  const body = { hookSpecificOutput };
  if (vd.decision !== Decision.ALLOW) {
    body.decision = "block";
    if (vd.reason !== undefined) body.reason = vd.reason;
  }
  // The same guarantee the pre-tool body makes, for the same reason: the
  // documented post-tool schema pairs `decision` with a `reason`, and a block
  // whose reason Codex may drop is a block that may not bite. Unverified for
  // PostToolUse specifically — a non-empty reason is the safe side of that, and
  // the model needs the text either way.
  if (enforced && !body.reason) body.reason = DEFAULT_DENY_REASON;
  return body;
}

/** @type {import("../control-plane.mjs").Adapter} */
export const codexAdapter = {
  AGENT,
  INTEGRATION_MODE,
  COVERAGE,
  UNRENDERED_FIELDS,
  NATIVE_EVENT_FOR,
  parse,
  render,
};
