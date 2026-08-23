/**
 * The Claude Code adapter — reference EXTERNAL_HOOK translator.
 *
 * The ONLY module that knows Claude Code's native hook field names
 * (`hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `prompt`,
 * `permissionDecision`, `hookSpecificOutput`). Transport is external-hook: the
 * agent shells out with stdin JSON and reads a deny body / exit code back.
 *
 * Deny signal (PreToolUse): `hookSpecificOutput.permissionDecision = "deny"`
 * AND exit 2. this_call_vetoable is true, but per the doctrine that is a
 * useful FIRST filter, never the boundary — the Verdict stays advisory to the
 * sandbox.
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
  UNRENDERED_ON_UNKNOWN,
  readonlySet,
  collectPassthrough,
  asObject,
  asString,
  asStringOrNull,
} from "../control-plane.mjs";

/** @typedef {import("../control-plane.mjs").ToolCallEvent} ToolCallEvent */
/** @typedef {import("../control-plane.mjs").Verdict} Verdict */
/** @typedef {import("../control-plane.mjs").EventMeta} EventMeta */
/** @typedef {import("../control-plane.mjs").NativeResponse} NativeResponse */

/** Producing-agent id stamped onto every event this adapter parses. */
export const AGENT = "claude";

/** How this adapter attaches to the agent. */
export const INTEGRATION_MODE = IntegrationMode.EXTERNAL_HOOK;

/**
 * Hook-coverage matrix row (`docs/hook-coverage-matrix.md`). `PreToolUse` fires
 * for builtins, for MCP tools (surfaced as `mcp__<server>__<tool>` through the
 * same hook), and for every tool a subagent uses (subagents do not inherit the
 * parent's permissions, so the hook is often their only gate). Resumed sessions
 * re-read hooks from settings and fire per new call — structural, uncontested.
 */
/** @type {import("../control-plane.mjs").CoverageMap} */
export const COVERAGE = Object.freeze({
  [CallClass.BUILTIN]: CoverageStatus.COVERED,
  [CallClass.MCP]: CoverageStatus.COVERED,
  [CallClass.SUBAGENT]: CoverageStatus.COVERED,
  [CallClass.RESUMED]: CoverageStatus.COVERED,
});

/**
 * The event kinds this host can actually gate. Claude Code honours a deny on these three. SESSION_START is left out: exit 2 does
 * not abort a session start, and the matrix documents no host response for it — an
 * undocumented kind is fail-closed to non-vetoable, the same rule coverage uses.
 * A kind absent here parses non-vetoable, so an unmodelled event never renders as
 * an enforced block the host will not perform. Module-private: `Object.freeze` does
 * not stop `Set.add`, so an exported set would let a consumer add UNKNOWN back after
 * `assertGatedKinds` has already run.
 */
const GATED_EVENTS = Object.freeze(
  new Set([EventKind.PRE_TOOL, EventKind.POST_TOOL, EventKind.PROMPT_SUBMIT]),
);
assertGatedKinds(GATED_EVENTS, AGENT);

// The kinds whose only content channel is context: the tool has already run
// (or there is no tool), so neither an input nor an output replacement has
// anywhere to go.
const CONTEXT_ONLY = readonlySet(["mutated_input", "mutated_output"]);

/**
 * Which {@link VERDICT_CONTENT_FIELDS} have no native channel on each event
 * kind, so `render` drops them. Claude Code splits its content channels by
 * event: `updatedInput` exists only on PreToolUse (the call has not run yet),
 * and `updatedToolOutput` only on PostToolUse (there is no tool output to
 * replace anywhere else). `additionalContext` is the one channel every kind
 * carries. The conformance harness holds this to what `render` actually emits,
 * in both directions.
 *
 * `additionalContext` on PreToolUse is inherited behaviour, not a checked claim:
 * Claude Code documents the field for UserPromptSubmit, SessionStart and
 * PostToolUse, and this adapter has emitted it on PreToolUse since before the
 * declaration existed. Rule ⑩ can see that the value reaches the wire, never
 * that the host reads the key — confirm it against the hook reference before
 * relying on it.
 * @type {Record<string, ReadonlySet<string>|undefined>}
 */
export const UNRENDERED_FIELDS = Object.freeze({
  [EventKind.PRE_TOOL]: readonlySet(["mutated_output"]),
  [EventKind.POST_TOOL]: readonlySet(["mutated_input"]),
  [EventKind.PROMPT_SUBMIT]: CONTEXT_ONLY,
  [EventKind.SESSION_START]: CONTEXT_ONLY,
  [EventKind.UNKNOWN]: UNRENDERED_ON_UNKNOWN,
});

/** Claude Code native hook event names (the `hook_event_name` field). */
export const HookEvent = Object.freeze({
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
  SESSION_START: "SessionStart",
});

const NATIVE_TO_KIND = Object.freeze({
  [HookEvent.PRE_TOOL_USE]: EventKind.PRE_TOOL,
  [HookEvent.POST_TOOL_USE]: EventKind.POST_TOOL,
  [HookEvent.USER_PROMPT_SUBMIT]: EventKind.PROMPT_SUBMIT,
  [HookEvent.SESSION_START]: EventKind.SESSION_START,
});

const KIND_TO_NATIVE = Object.freeze({
  [EventKind.PRE_TOOL]: HookEvent.PRE_TOOL_USE,
  [EventKind.POST_TOOL]: HookEvent.POST_TOOL_USE,
  [EventKind.PROMPT_SUBMIT]: HookEvent.USER_PROMPT_SUBMIT,
  [EventKind.SESSION_START]: HookEvent.SESSION_START,
});

/**
 * The native event a conformance probe should carry for each kind — this
 * adapter's own answer, so an every-kind probe exercises the branch that kind
 * really takes. `unknown` has no native name by definition and is absent.
 * @type {Record<string, string|undefined>}
 */
export const NATIVE_EVENT_FOR = KIND_TO_NATIVE;

const CONSUMED = new Set([
  "hook_event_name",
  "session_id",
  "cwd",
  "permission_mode",
  "transcript_path",
  "tool_name",
  "tool_input",
  "tool_response",
  "prompt",
]);

/**
 * @param {string} kind
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
function claudeInput(kind, raw) {
  if (kind === EventKind.PROMPT_SUBMIT)
    return { prompt: asString(raw.prompt, "") };
  if (kind === EventKind.SESSION_START) return {};
  return asObject(raw.tool_input);
}

/**
 * @param {string} kind
 * @param {Record<string, unknown>} raw
 * @returns {string|null}
 */
function claudeTool(kind, raw) {
  if (kind === EventKind.PROMPT_SUBMIT || kind === EventKind.SESSION_START)
    return null;
  return asStringOrNull(raw.tool_name);
}

/**
 * @param {string} nativeEvent
 * @param {Record<string, unknown>} raw
 * @returns {EventMeta}
 */
function claudeMeta(nativeEvent, raw) {
  /** @type {EventMeta} */
  const meta = {
    agent: AGENT,
    native_event: nativeEvent,
    integration_mode: INTEGRATION_MODE,
    primary_gate_present: true,
    passthrough: collectPassthrough(raw, CONSUMED),
  };
  if (typeof raw.session_id === "string") meta.session_id = raw.session_id;
  if (typeof raw.cwd === "string") meta.cwd = raw.cwd;
  if (typeof raw.permission_mode === "string")
    meta.permission_mode = raw.permission_mode;
  if (typeof raw.transcript_path === "string")
    meta.transcript_path = raw.transcript_path;
  return meta;
}

/**
 * Parse a raw Claude Code hook payload into a normalized {@link ToolCallEvent}.
 * Never throws on an unmodelled event type or tool-input field.
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
  const response = kind === EventKind.POST_TOOL ? raw.tool_response : undefined;
  const nativeTool = claudeTool(kind, raw);
  const meta = claudeMeta(nativeEvent, raw);
  if (nativeTool !== null) meta.native_tool = nativeTool;
  return makeEvent({
    event: kind,
    tool: canonicalTool(nativeTool),
    input: claudeInput(kind, raw),
    response,
    // Classify on the NATIVE name — MCP detection keys on `mcp__…`, which a
    // canonical builtin name would never carry.
    this_call_vetoable: vetoableFor(
      kind,
      GATED_EVENTS,
      COVERAGE[classifyCallClass(nativeTool, raw)],
    ),
    meta,
  });
}

/**
 * Render into Claude Code's native external-hook transport: a
 * `hookSpecificOutput` JSON body on stdout plus the exit code that carries the
 * decision (deny ⇒ exit 2). A deny only counts as `enforced` when the event's
 * `this_call_vetoable` holds.
 *
 * `soleGate` (default `false`) is a dangerous, explicit opt-in: when `true` AND
 * the verdict is `allow`, the render emits Claude Code's REAL
 * `permissionDecision: "allow"`, which bypasses the native permission prompt.
 * Default behavior always abstains on allow (see {@link gatingBody}) so the
 * guardrail can never silently become the sole gate by accident.
 * @param {Verdict} verdict
 * @param {ToolCallEvent} event
 * @param {{ soleGate?: boolean }} [options]
 * @returns {NativeResponse}
 */
export function render(verdict, event, { soleGate = false } = {}) {
  const vd = normalizeVerdict(verdict);
  const kind = event.event;
  const hookEventName =
    /** @type {Record<string, string>} */ (KIND_TO_NATIVE)[kind] ??
    event.meta.native_event;
  const isDeny = vd.decision === Decision.DENY;
  const enforced = isDeny && event.this_call_vetoable;

  /** @type {Record<string, unknown>} */
  const stdout =
    kind === EventKind.PRE_TOOL
      ? gatingBody(hookEventName, vd, soleGate)
      : nonGatingBody(hookEventName, kind, vd);

  return nativeResponse({
    transport: INTEGRATION_MODE,
    exit_code: enforced ? 2 : 0,
    enforced,
    stdout,
  });
}

/**
 * Build a PreToolUse `hookSpecificOutput`. `allow` OMITS `permissionDecision`
 * by default — in Claude Code that field auto-approves the call, bypassing the
 * normal permission prompt, so a guardrail that merely has "no objection" must
 * stay silent on it and let the default flow run. Only `deny`/`ask` emit an
 * explicit `permissionDecision`, UNLESS `soleGate` is true, in which case an
 * `allow` also emits the real `permissionDecision: "allow"` (the monitor-as-
 * sole-gate opt-in). `updatedInput`/`additionalContext` ride along regardless.
 * @param {string} hookEventName
 * @param {Verdict} vd
 * @param {boolean} soleGate
 * @returns {Record<string, unknown>}
 */
function gatingBody(hookEventName, vd, soleGate) {
  /** @type {Record<string, unknown>} */
  const out = { hookEventName };
  if (vd.decision !== Decision.ALLOW || soleGate) {
    out.permissionDecision = vd.decision;
    if (vd.reason !== undefined) out.permissionDecisionReason = vd.reason;
  }
  if (vd.mutated_input !== undefined) out.updatedInput = vd.mutated_input;
  if (vd.additional_context !== undefined)
    out.additionalContext = vd.additional_context;
  return { hookSpecificOutput: out };
}

/**
 * @param {string} hookEventName
 * @param {string} kind the normalized {@link EventKind} being rendered
 * @param {Verdict} vd
 * @returns {Record<string, unknown>}
 */
function nonGatingBody(hookEventName, kind, vd) {
  /** @type {Record<string, unknown>} */
  const hookSpecificOutput = { hookEventName };
  // A PostToolUse content transform: `updatedToolOutput` replaces what the model
  // sees (the tool already ran, so this governs only the model's view). The
  // native channel for the whole redaction/sanitize pipeline. PostToolUse ONLY:
  // a UserPromptSubmit or SessionStart carries no tool output, so the field is
  // dropped there (declared in {@link UNRENDERED_FIELDS}) rather than emitted
  // into a key the host ignores, which reads to a caller as a redaction applied.
  if (kind === EventKind.POST_TOOL && vd.mutated_output !== undefined)
    hookSpecificOutput.updatedToolOutput = vd.mutated_output;
  // Not on an UNKNOWN kind: `hookEventName` there is the unrecognized native
  // event name, so the adapter has established no channel to write into.
  if (kind !== EventKind.UNKNOWN && vd.additional_context !== undefined)
    hookSpecificOutput.additionalContext = vd.additional_context;
  /** @type {Record<string, unknown>} */
  const out = { hookSpecificOutput };
  if (vd.decision !== Decision.ALLOW) {
    out.decision = "block";
    if (vd.reason !== undefined) out.reason = vd.reason;
  }
  return out;
}

/** @type {import("../control-plane.mjs").Adapter} */
export const claudeAdapter = {
  AGENT,
  INTEGRATION_MODE,
  COVERAGE,
  UNRENDERED_FIELDS,
  NATIVE_EVENT_FOR,
  parse,
  render,
};
