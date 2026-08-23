/**
 * The Amp adapter — EXTERNAL_HOOK translator with a pure exit-code transport.
 *
 * Amp's `amp.permissions` `delegate` rule invokes a helper on PATH; the helper's
 * EXIT CODE is the whole decision — 0 allow / 1 ask / 2 reject — with no JSON
 * body. Managed pin: /etc/ampcode/managed-settings.json overrides user+workspace
 * (pin the delegate rule there). Transcript is server-canonical `--stream-json`.
 *
 * This adapter is what proves the transport split earns its keep: the normalized
 * ToolCallEvent/Verdict are identical to Claude's, but `render` carries the
 * decision in `exit_code` with no `stdout` at all.
 */

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
  VERDICT_CONTENT_FIELDS,
  collectPassthrough,
  asObject,
  asStringOrNull,
} from "../control-plane.mjs";

/** @typedef {import("../control-plane.mjs").ToolCallEvent} ToolCallEvent */
/** @typedef {import("../control-plane.mjs").Verdict} Verdict */
/** @typedef {import("../control-plane.mjs").EventMeta} EventMeta */
/** @typedef {import("../control-plane.mjs").NativeResponse} NativeResponse */

export const AGENT = "amp";
export const INTEGRATION_MODE = IntegrationMode.EXTERNAL_HOOK;

/**
 * Hook-coverage matrix row (`docs/hook-coverage-matrix.md`). Every tool call is
 * checked against the permission engine; `amp.mcpPermissions` runs MCP tools
 * through the same rule syntax, and a rule's `context: "subagent"` selector
 * gates calls inside subagents — so builtin, MCP, and subagent are all COVERED.
 * Resumed-thread firing is a strong-but-uncited structural argument, so it is
 * held at UNKNOWN until an item-⑤ probe confirms it.
 */
/** @type {import("../control-plane.mjs").CoverageMap} */
export const COVERAGE = Object.freeze({
  [CallClass.BUILTIN]: CoverageStatus.COVERED,
  [CallClass.MCP]: CoverageStatus.COVERED,
  [CallClass.SUBAGENT]: CoverageStatus.COVERED,
  [CallClass.RESUMED]: CoverageStatus.UNKNOWN,
});

/**
 * The event kinds this host can actually gate. Amp invokes the delegate for a tool call and nothing else, so parse only ever emits PRE_TOOL.
 * A kind absent here parses non-vetoable, so an unmodelled event never renders as
 * an enforced block the host will not perform. Module-private: `Object.freeze` does
 * not stop `Set.add`, so an exported set would let a consumer add UNKNOWN back
 * after `assertGatedKinds` has already run.
 */
const GATED_EVENTS = Object.freeze(new Set([EventKind.PRE_TOOL]));
assertGatedKinds(GATED_EVENTS, AGENT);

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
export const UNRENDERED_FIELDS = Object.freeze(
  Object.fromEntries(
    Object.values(EventKind).map((kind) => [
      kind,
      Object.freeze(new Set(VERDICT_CONTENT_FIELDS)),
    ]),
  ),
);

// Amp invokes the delegate for a tool call; the payload carries the tool name +
// input and the session context. Pinned by fixtures/amp.json.
const CONSUMED = new Set(["tool", "input", "session_id", "cwd"]);

/**
 * @param {any} native
 * @returns {ToolCallEvent}
 */
export function parse(native) {
  const raw = asObject(native);
  /** @type {EventMeta} */
  const meta = {
    agent: AGENT,
    native_event: "delegate",
    integration_mode: INTEGRATION_MODE,
    primary_gate_present: true,
    passthrough: collectPassthrough(raw, CONSUMED),
  };
  if (typeof raw.session_id === "string") meta.session_id = raw.session_id;
  if (typeof raw.cwd === "string") meta.cwd = raw.cwd;
  const nativeTool = asStringOrNull(raw.tool);
  if (nativeTool !== null) meta.native_tool = nativeTool;
  return makeEvent({
    event: EventKind.PRE_TOOL,
    tool: canonicalTool(nativeTool),
    input: asObject(raw.input),
    response: undefined,
    // Classify on the NATIVE name (MCP detection keys on `mcp__…`).
    this_call_vetoable: vetoableFor(
      EventKind.PRE_TOOL,
      GATED_EVENTS,
      COVERAGE[classifyCallClass(nativeTool, raw)],
    ),
    meta,
  });
}

/**
 * The EXHAUSTIVE (decision × `this_call_vetoable`) → exit-code table for Amp's
 * pure exit-code transport: 0 allow / 1 ask / 2 reject.
 *
 * Written as a total table rather than a ternary chain because the chain's
 * fall-through case was ALLOW: an unenforceable deny — a deny on a call this
 * guardrail cannot veto — silently rendered as exit 0, Amp's "run it". A
 * combination this table forgets is a construction error (below), not a silent
 * approval.
 *
 * The non-vetoable DENY row is exit 1 (ask), not 0. Amp has a real ask tier, so
 * the honest render of "I object but cannot block" is to put the call in front
 * of the human rather than wave it through. It is still `enforced: false` — the
 * guardrail is not claiming a veto it does not have; it is declining to spend
 * its one remaining signal on an approval.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, number>>>>}
 */
const EXIT_CODE_BY_DECISION = Object.freeze({
  [Decision.ALLOW]: Object.freeze({ true: 0, false: 0 }),
  [Decision.DENY]: Object.freeze({ true: 2, false: 1 }),
  [Decision.ASK]: Object.freeze({ true: 1, false: 1 }),
});

/**
 * Totality check at IMPORT: every {@link Decision} must have a row and every row
 * both vetoable columns. A decision added to the contract breaks this module
 * loudly at load instead of silently defaulting to exit 0.
 */
for (const decision of Object.values(Decision)) {
  const row = lookup(EXIT_CODE_BY_DECISION, decision);
  if (row === undefined)
    throw new Error(
      `amp adapter: exit-code table has no row for decision ${JSON.stringify(decision)}`,
    );
  for (const vetoable of ["true", "false"]) {
    if (typeof lookup(row, vetoable) === "number") continue;
    throw new Error(
      `amp adapter: exit-code table row ${JSON.stringify(decision)} has no this_call_vetoable=${vetoable} column`,
    );
  }
}

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
export function render(verdict, event) {
  const vd = normalizeVerdict(verdict);
  const vetoable = event.this_call_vetoable;
  // `makeEvent` already rejects a non-boolean, so reaching this means a
  // hand-built event — and guessing whether it can be vetoed is how fail-open
  // starts. The string "true" is the case that makes this a real check rather
  // than a formality: it would otherwise index the vetoable column.
  if (typeof vetoable !== "boolean")
    throw new Error(
      `amp adapter: this_call_vetoable must be a boolean, got ${JSON.stringify(vetoable)}`,
    );
  const enforced = vd.decision === Decision.DENY && vetoable;
  const exit_code = lookup(
    lookup(EXIT_CODE_BY_DECISION, vd.decision) ?? {},
    String(vetoable),
  );
  // Unreachable while the import-time totality check and `normalizeVerdict` both
  // hold; kept because the alternative to throwing is `exit_code: undefined`,
  // which `process.exit` renders as 0 — the exact silent allow this table exists
  // to eliminate.
  if (exit_code === undefined)
    throw new Error(
      `amp adapter: exit-code table has no entry for decision ${JSON.stringify(vd.decision)} / this_call_vetoable ${JSON.stringify(vetoable)}`,
    );
  return nativeResponse({ transport: INTEGRATION_MODE, exit_code, enforced });
}

/** @type {import("../control-plane.mjs").Adapter} */
export const ampAdapter = {
  AGENT,
  INTEGRATION_MODE,
  COVERAGE,
  UNRENDERED_FIELDS,
  parse,
  render,
};
