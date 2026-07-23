/**
 * The Codex CLI adapter — EXTERNAL_HOOK translator (≥ v0.135).
 *
 * Real Codex speaks nearly the same protocol as Claude Code: `PreToolUse` and
 * `PermissionRequest` hook events with `tool_name`/`tool_input`, and a deny
 * expressed as `hookSpecificOutput.permissionDecision = "deny"` plus exit 2.
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
  coverageAllowsVeto,
  canonicalTool,
  makeEvent,
  normalizeVerdict,
  nativeResponse,
  collectPassthrough,
  asObject,
  asString,
  asStringOrNull,
} from "../control-plane.mjs";

/** @typedef {import("../control-plane.mjs").ToolCallEvent} ToolCallEvent */
/** @typedef {import("../control-plane.mjs").Verdict} Verdict */
/** @typedef {import("../control-plane.mjs").EventMeta} EventMeta */
/** @typedef {import("../control-plane.mjs").NativeResponse} NativeResponse */

export const AGENT = "codex";
export const INTEGRATION_MODE = IntegrationMode.EXTERNAL_HOOK;

/**
 * Hook-coverage matrix row (`docs/hook-coverage-matrix.md`). `PreToolUse`
 * intercepts the shell (Bash) tool ONLY — other builtins and MCP tools never
 * reach it — so builtin is PARTIAL and MCP is UNCOVERED. Subagent and resumed
 * firing are undocumented ⇒ UNKNOWN (treated as uncovered until an item-⑤ probe
 * proves otherwise).
 */
/** @type {import("../control-plane.mjs").CoverageMap} */
export const COVERAGE = Object.freeze({
  [CallClass.BUILTIN]: CoverageStatus.PARTIAL,
  [CallClass.MCP]: CoverageStatus.UNCOVERED,
  [CallClass.SUBAGENT]: CoverageStatus.UNKNOWN,
  [CallClass.RESUMED]: CoverageStatus.UNKNOWN,
});

/** Minimum Codex version whose hook can actually veto a tool call. */
export const MIN_ENFORCING_VERSION = Object.freeze([0, 135]);

/** {@link MIN_ENFORCING_VERSION} as the semver string the gate compares against. */
const MIN_ENFORCING_SEMVER = `${MIN_ENFORCING_VERSION[0]}.${MIN_ENFORCING_VERSION[1]}.0`;

// Both native events gate a tool call; PermissionRequest is the ask-tier veto.
const GATING_EVENTS = new Set(["PreToolUse", "PermissionRequest"]);

// Codex drops an enforced deny that carries no (or an empty) reason and runs the
// tool, so a reasonless enforced deny still renders a non-empty one.
export const DEFAULT_DENY_REASON = "blocked by monitor";

const CONSUMED = new Set([
  "hook_event_name",
  "session_id",
  "cwd",
  "permission_mode",
  "transcript_path",
  "tool_name",
  "tool_input",
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
 * Parse a raw Codex hook payload. Never throws on unmodelled input. Marks the
 * event observe-only (this_call_vetoable=false) when the Codex version
 * predates hook enforcement.
 * @param {any} native
 * @returns {ToolCallEvent}
 */
export function parse(native) {
  const raw = asObject(native);
  const nativeEvent = asString(raw.hook_event_name, "");
  const gating = GATING_EVENTS.has(nativeEvent);
  const kind = gating ? EventKind.PRE_TOOL : EventKind.UNKNOWN;
  const enforce = canEnforce(raw.version);

  /** @type {EventMeta} */
  const meta = {
    agent: AGENT,
    native_event: nativeEvent,
    integration_mode: enforce
      ? IntegrationMode.EXTERNAL_HOOK
      : IntegrationMode.OBSERVE_ONLY,
    primary_gate_present: true,
    passthrough: collectPassthrough(raw, CONSUMED),
  };
  if (typeof raw.session_id === "string") meta.session_id = raw.session_id;
  if (typeof raw.cwd === "string") meta.cwd = raw.cwd;
  if (typeof raw.permission_mode === "string")
    meta.permission_mode = raw.permission_mode;
  if (typeof raw.transcript_path === "string")
    meta.transcript_path = raw.transcript_path;

  // Coverage floor: even on an enforcing Codex, `PreToolUse` fires for Bash only,
  // so an MCP-sourced call is un-vetoable regardless of version (COVERAGE.mcp).
  // Classify on the NATIVE name (MCP detection keys on `mcp__…`).
  const nativeTool = asStringOrNull(raw.tool_name);
  if (nativeTool !== null) meta.native_tool = nativeTool;
  const vetoable =
    enforce && coverageAllowsVeto(COVERAGE[classifyCallClass(nativeTool, raw)]);

  return makeEvent({
    event: kind,
    tool: canonicalTool(nativeTool),
    input: asObject(raw.tool_input),
    response: undefined,
    this_call_vetoable: vetoable,
    meta,
  });
}

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
export function render(verdict, event, { soleGate = false } = {}) {
  const vd = normalizeVerdict(verdict);
  const enforced = vd.decision === Decision.DENY && event.this_call_vetoable;
  const hookEventName = event.meta.native_event || "PreToolUse";

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
  if (vd.mutated_input !== undefined) body.updatedInput = vd.mutated_input;

  return nativeResponse({
    transport: event.meta.integration_mode,
    exit_code: enforced ? 2 : 0,
    enforced,
    stdout: { hookSpecificOutput: body },
  });
}

/** @type {import("../control-plane.mjs").Adapter} */
export const codexAdapter = {
  AGENT,
  INTEGRATION_MODE,
  COVERAGE,
  parse,
  render,
};
