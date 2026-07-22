/**
 * The Gemini CLI adapter — EXTERNAL_HOOK translator (hooks since v0.26.0).
 *
 * The only module that knows Gemini CLI's native hook field names. Transport is
 * external-hook: the agent shells out with stdin JSON and reads a stdout body +
 * exit code back, but the vocabulary differs from Claude/Codex — the pre-tool
 * event is `BeforeTool` (not `PreToolUse`), tool names are snake_case
 * (`run_shell_command`), and the decision body is `{ decision, reason,
 * hookSpecificOutput: { tool_input } }` rather than `permissionDecision`.
 *
 * Decision channel (from geminicli.com/docs/hooks/reference): exit 0 → stdout is
 * parsed as JSON (the path for allow / advisory / mutation); exit 2 → a "System
 * Block" that pre-empts the call, with the reason taken from STDERR (stdout is
 * ignored). So an ENFORCED deny renders as exit 2 (the only real block signal),
 * and its `reason` has no home in this stdout-only NativeResponse — it is
 * dropped here (a real hook wrapper also writes it to stderr), the same fidelity
 * gap Amp's exit-code transport has. Gemini has no native "ask" tier, so `ask`
 * maps to an exit-0 advisory `decision: "deny"` the model sees but that does not
 * hard-block.
 *
 * PIN GAP (sandbox, not adapter — carried here because this is the module that
 * knows the host is pin-dependent): Gemini CLI's system settings file wins over
 * other settings FILES, but environment variables and CLI argv still override it,
 * and `GEMINI_CLI_SYSTEM_SETTINGS_PATH` redirects WHERE the system file is read
 * from (geminicli.com/docs/reference/configuration). So mounting the pinned
 * system settings file read-only is NOT sufficient on Gemini CLI: an agent that
 * controls its own env or launch argv routes around it. The launcher must ALSO
 * fix `GEMINI_CLI_SYSTEM_SETTINGS_PATH` and the per-invocation env/argv the agent
 * can't rewrite. See docs/monitor-invariants.md §Invariant 1.
 */

import {
  EventKind,
  Decision,
  IntegrationMode,
  CallClass,
  CoverageStatus,
  classifyCallClass,
  coverageAllowsVeto,
  canonicalTool,
  lookup,
  assertAliasTargetsModeled,
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

export const AGENT = "gemini";
export const INTEGRATION_MODE = IntegrationMode.EXTERNAL_HOOK;

/**
 * Hook-coverage matrix row (`docs/hook-coverage-matrix.md`). `BeforeTool` gates
 * builtins on v0.26+ (COVERED). MCP routing through the same matcher is only
 * MEDIUM-confidence and unproven, subagent firing for a loaded agent is
 * undocumented, and resumed-session behavior has no source — all three are
 * UNKNOWN, held at fail-closed until an item-⑤ probe upgrades them. A guessed ✅
 * here would be a silent fail-open.
 */
/** @type {import("../control-plane.mjs").CoverageMap} */
export const COVERAGE = Object.freeze({
  [CallClass.BUILTIN]: CoverageStatus.COVERED,
  [CallClass.MCP]: CoverageStatus.UNKNOWN,
  [CallClass.SUBAGENT]: CoverageStatus.UNKNOWN,
  [CallClass.RESUMED]: CoverageStatus.UNKNOWN,
});

/** Gemini CLI native hook event names (the `hook_event_name` field). */
export const HookEvent = Object.freeze({
  BEFORE_TOOL: "BeforeTool",
  AFTER_TOOL: "AfterTool",
  BEFORE_AGENT: "BeforeAgent",
});

const NATIVE_TO_KIND = Object.freeze({
  [HookEvent.BEFORE_TOOL]: EventKind.PRE_TOOL,
  [HookEvent.AFTER_TOOL]: EventKind.POST_TOOL,
  [HookEvent.BEFORE_AGENT]: EventKind.PROMPT_SUBMIT,
});

// Only the fields the adapter maps are consumed; everything else (timestamp,
// mcp_context, original_request_name, …) survives verbatim in meta.passthrough.
const CONSUMED = new Set([
  "hook_event_name",
  "session_id",
  "cwd",
  "transcript_path",
  "tool_name",
  "tool_input",
  "tool_response",
  "prompt",
]);

/**
 * @param {string} nativeEvent
 * @param {Record<string, unknown>} raw
 * @returns {EventMeta}
 */
function geminiMeta(nativeEvent, raw) {
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
  if (typeof raw.transcript_path === "string")
    meta.transcript_path = raw.transcript_path;
  return meta;
}

/**
 * Adapter-scoped native-builtin → canonical tool aliases, applied ONLY when a
 * call classifies as BUILTIN. These names are too generic for the global
 * {@link TOOL_ALIASES} (an MCP server could export a `read_file`), but Gemini
 * CLI removes the ambiguity at parse time: every MCP tool is unconditionally
 * registered — and surfaced in hook payloads — under its fully qualified
 * `mcp_{server}_{tool}` name (gemini-cli docs/tools/mcp-server.md), so a bare
 * builtin name in `tool_name` can only be the builtin. The builtin's native
 * input fields still pass through verbatim (e.g. read_file's `absolute_path`,
 * not Read's `file_path`) — `meta.native_tool` tells a consumer which field
 * dialect to expect. Targets are pinned to {@link MODELED_TOOLS} at import, and
 * every entry must be witnessed by a gemini conformance fixture
 * (`assertToolAliasesCovered`).
 * @type {Readonly<Record<string, string>>}
 */
export const GEMINI_TOOL_ALIASES = Object.freeze({
  read_file: "Read",
  write_file: "Write",
  web_fetch: "WebFetch",
});

assertAliasTargetsModeled(GEMINI_TOOL_ALIASES);

/**
 * Canonicalize a Gemini native tool name: adapter-scoped builtin aliases first
 * (BUILTIN calls only — an MCP- or context-flagged call is never reclassified),
 * then the global {@link canonicalTool} map, else verbatim.
 * @param {string|null} nativeTool
 * @param {string} callClass a {@link CallClass} value
 * @returns {string|null}
 */
function geminiCanonicalTool(nativeTool, callClass) {
  if (nativeTool !== null && callClass === CallClass.BUILTIN) {
    const scoped = lookup(GEMINI_TOOL_ALIASES, nativeTool);
    if (scoped !== undefined) return scoped;
  }
  return canonicalTool(nativeTool);
}

/**
 * @param {string} kind
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
function geminiInput(kind, raw) {
  if (kind === EventKind.PROMPT_SUBMIT)
    return { prompt: asString(raw.prompt, "") };
  if (kind === EventKind.PRE_TOOL || kind === EventKind.POST_TOOL)
    return asObject(raw.tool_input);
  return {};
}

/**
 * Parse a raw Gemini CLI hook payload into a normalized {@link ToolCallEvent}.
 * Never throws on an unmodelled event type or tool-input field. A payload comes
 * from a hooks-capable Gemini (v0.26.0+) whose `BeforeTool` can pre-empt builtin
 * tools via exit 2. But MCP firing is only medium-confidence (COVERAGE.mcp is
 * UNKNOWN), so an MCP-sourced call — flagged by `mcp_context` or an `mcp_`-named
 * tool — parses non-vetoable until an item-⑤ probe confirms the hook fires.
 * `BeforeAgent` (fires after the user submits a prompt, before planning) maps to
 * `prompt_submit`: no tool, the submitted text folded into `input.prompt`.
 * @param {any} native
 * @returns {ToolCallEvent}
 */
export function parse(native) {
  const raw = asObject(native);
  const nativeEvent =
    typeof raw.hook_event_name === "string" ? raw.hook_event_name : "";
  const kind =
    lookup(
      /** @type {Record<string, string>} */ (NATIVE_TO_KIND),
      nativeEvent,
    ) ?? EventKind.UNKNOWN;
  const gating = kind === EventKind.PRE_TOOL || kind === EventKind.POST_TOOL;
  const response = kind === EventKind.POST_TOOL ? raw.tool_response : undefined;
  const nativeTool = gating ? asStringOrNull(raw.tool_name) : null;
  const meta = geminiMeta(nativeEvent, raw);
  if (nativeTool !== null) meta.native_tool = nativeTool;
  // Classify on the NATIVE name (MCP detection keys on the `mcp_…` FQN prefix
  // every Gemini MCP tool carries); the class gates both the veto flag and the
  // builtin-only adapter-scoped aliases.
  const callClass = classifyCallClass(nativeTool, raw);
  return makeEvent({
    event: kind,
    tool: geminiCanonicalTool(nativeTool, callClass),
    input: geminiInput(kind, raw),
    response,
    this_call_vetoable: coverageAllowsVeto(COVERAGE[callClass]),
    meta,
  });
}

/**
 * Render into Gemini CLI's native external-hook transport. An enforceable deny
 * renders as exit 2 (the System Block on BeforeTool; documented on BeforeAgent
 * as "same as decision: deny" — it aborts the turn); everything else exits 0
 * with a JSON decision body (or none, when `allow` abstains). `soleGate`
 * (default false) is the same dangerous opt-in as the other adapters: it makes
 * an `allow` emit the real `decision: "allow"` instead of abstaining (tool
 * events only — BeforeAgent documents no allow behavior to opt into).
 * @param {Verdict} verdict
 * @param {ToolCallEvent} event
 * @param {{ soleGate?: boolean }} [options]
 * @returns {NativeResponse}
 */
export function render(verdict, event, { soleGate = false } = {}) {
  const vd = normalizeVerdict(verdict);
  const enforced = vd.decision === Decision.DENY && event.this_call_vetoable;

  // Enforced deny is a System Block: exit 2, reason carried on stderr (no home
  // in this stdout-only response), so no stdout body.
  if (enforced)
    return nativeResponse({
      transport: INTEGRATION_MODE,
      exit_code: 2,
      enforced: true,
    });

  const body =
    event.event === EventKind.PROMPT_SUBMIT
      ? promptSubmitBody(vd)
      : decisionBody(vd, soleGate);
  return nativeResponse({
    transport: INTEGRATION_MODE,
    exit_code: 0,
    enforced: false,
    ...(body === undefined ? {} : { stdout: body }),
  });
}

/**
 * Build the exit-0 stdout decision body. `allow` abstains — no `decision` key,
 * so Gemini runs its normal flow — unless `soleGate` opts into the real
 * `decision: "allow"`. `deny`/`ask` both surface an advisory `decision: "deny"`
 * (Gemini has no native ask tier). `mutated_input` rides along as
 * `hookSpecificOutput.tool_input` and `additional_context` as Gemini's native
 * `systemMessage`. Returns undefined when there is nothing to emit (a pure
 * abstaining allow).
 * @param {Verdict} vd
 * @param {boolean} soleGate
 * @returns {Record<string, unknown>|undefined}
 */
function decisionBody(vd, soleGate) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (vd.decision === Decision.DENY || vd.decision === Decision.ASK) {
    out.decision = "deny";
    if (vd.reason !== undefined) out.reason = vd.reason;
  } else if (soleGate) {
    out.decision = "allow";
  }
  if (vd.mutated_input !== undefined)
    out.hookSpecificOutput = { tool_input: vd.mutated_input };
  if (vd.additional_context !== undefined)
    out.systemMessage = vd.additional_context;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build the exit-0 stdout body for a `prompt_submit` (BeforeAgent) render.
 * BeforeAgent's documented channels differ from BeforeTool's: `decision:
 * "deny"` blocks the turn and discards the prompt, and context injection is
 * `hookSpecificOutput.additionalContext` (appended to the prompt for this turn
 * only) — there is no `tool_input` to mutate and no documented allow decision,
 * so `allow` always abstains and `mutated_input` has no home here. `deny`/`ask`
 * both surface `decision: "deny"` with the reason, mirroring how BeforeTool
 * renders ask (Gemini has no native ask tier). Returns undefined when there is
 * nothing to emit.
 * @param {Verdict} vd
 * @returns {Record<string, unknown>|undefined}
 */
function promptSubmitBody(vd) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (vd.decision === Decision.DENY || vd.decision === Decision.ASK) {
    out.decision = "deny";
    if (vd.reason !== undefined) out.reason = vd.reason;
  }
  if (vd.additional_context !== undefined)
    out.hookSpecificOutput = { additionalContext: vd.additional_context };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** @type {import("../control-plane.mjs").Adapter} */
export const geminiAdapter = {
  AGENT,
  INTEGRATION_MODE,
  COVERAGE,
  parse,
  render,
};
