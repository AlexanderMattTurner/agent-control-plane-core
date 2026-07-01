/**
 * The Codex CLI adapter — EXTERNAL_HOOK translator (≥ v0.135).
 *
 * Real Codex speaks nearly the same protocol as Claude Code: `PreToolUse` and
 * `PermissionRequest` hook events with `tool_name`/`tool_input`, and a deny
 * expressed as `hookSpecificOutput.permissionDecision = "deny"` plus exit 2.
 * Managed pin: /etc/codex/requirements.toml + allow_managed_hooks_only.
 *
 * VERSION GATE: hook enforcement only exists in v0.135+. Below that, there is no
 * veto, so parse marks the event OBSERVE_ONLY with can_enforce=false — the
 * adapter must not pretend to enforce on an old Codex.
 */

import {
  EventKind,
  Decision,
  IntegrationMode,
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

/** Minimum Codex version whose hook can actually veto a tool call. */
export const MIN_ENFORCING_VERSION = Object.freeze([0, 135]);

// Both native events gate a tool call; PermissionRequest is the ask-tier veto.
const GATING_EVENTS = new Set(["PreToolUse", "PermissionRequest"]);

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
 * A missing/garbage version is treated as too old (fail closed to advisory).
 * @param {unknown} version
 * @returns {boolean}
 */
export function canEnforce(version) {
  const parts = asString(version, "").split(".");
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  if (major !== MIN_ENFORCING_VERSION[0])
    return major > MIN_ENFORCING_VERSION[0];
  return minor >= MIN_ENFORCING_VERSION[1];
}

/**
 * Parse a raw Codex hook payload. Never throws on unmodelled input. Marks the
 * event observe-only (can_enforce=false) when the Codex version predates hook
 * enforcement.
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
    can_enforce: enforce,
    primary_gate_present: true,
    passthrough: collectPassthrough(raw, CONSUMED),
  };
  if (typeof raw.session_id === "string") meta.session_id = raw.session_id;
  if (typeof raw.cwd === "string") meta.cwd = raw.cwd;
  if (typeof raw.permission_mode === "string")
    meta.permission_mode = raw.permission_mode;
  if (typeof raw.transcript_path === "string")
    meta.transcript_path = raw.transcript_path;

  return makeEvent({
    event: kind,
    tool: asStringOrNull(raw.tool_name),
    input: asObject(raw.tool_input),
    response: undefined,
    meta,
  });
}

/**
 * Render into Codex's native external-hook transport: a `hookSpecificOutput`
 * body preserving the native event name (`PreToolUse`/`PermissionRequest`) plus
 * exit 2 on an enforceable deny. On a pre-v0.135 Codex (`can_enforce` false) the
 * body still renders but exit stays 0 and `enforced` is false — advisory only.
 * @param {Verdict} verdict
 * @param {ToolCallEvent} event
 * @returns {NativeResponse}
 */
export function render(verdict, event) {
  const vd = normalizeVerdict(verdict);
  const enforced = vd.decision === Decision.DENY && event.meta.can_enforce;
  const hookEventName = event.meta.native_event || "PreToolUse";

  /** @type {Record<string, unknown>} */
  const body = { hookEventName, permissionDecision: vd.decision };
  if (vd.reason !== undefined) body.permissionDecisionReason = vd.reason;
  if (vd.mutated_input !== undefined) body.updatedInput = vd.mutated_input;

  return nativeResponse({
    transport: event.meta.integration_mode,
    exit_code: enforced ? 2 : 0,
    enforced,
    stdout: { hookSpecificOutput: body },
  });
}

/** @type {import("../control-plane.mjs").Adapter} */
export const codexAdapter = { AGENT, INTEGRATION_MODE, parse, render };
