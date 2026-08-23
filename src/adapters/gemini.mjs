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
 * with its `reason` carried on `NativeResponse.stderr` (which `emit` writes to fd
 * 2) so the System Block is never shown with no rationale. Gemini has no native
 * "ask" tier, so `ask` maps to an exit-0 advisory `decision: "deny"` the model
 * sees but that does not hard-block.
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
  vetoableFor,
  assertGatedKinds,
  canonicalTool,
  lookup,
  assertAliasTargetsModeled,
  makeEvent,
  normalizeVerdict,
  nativeResponse,
  UNRENDERED_ON_UNKNOWN,
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

/**
 * The event kinds this host can actually gate. Gemini CLI honours a deny on each of the three events NATIVE_TO_KIND maps.
 * A kind absent here parses non-vetoable, so an unmodelled event never renders as
 * an enforced block the host will not perform. Module-private: `Object.freeze` does
 * not stop `Set.add`, so an exported set would let a consumer add UNKNOWN back
 * after `assertGatedKinds` has already run.
 */
const GATED_EVENTS = Object.freeze(
  new Set([EventKind.PRE_TOOL, EventKind.POST_TOOL, EventKind.PROMPT_SUBMIT]),
);
assertGatedKinds(GATED_EVENTS, AGENT);

// The kinds whose only content channel is context: the tool has already run
// (or there is no tool), so neither an input nor an output replacement has
// anywhere to go.
const CONTEXT_ONLY = Object.freeze(
  new Set(["mutated_input", "mutated_output"]),
);

/**
 * Which {@link VERDICT_CONTENT_FIELDS} have no native channel on each event
 * kind, so `render` drops them. Gemini CLI documents
 * `hookSpecificOutput.tool_input` on BeforeTool, `systemMessage` on the tool
 * events and `hookSpecificOutput.additionalContext` on BeforeAgent. It documents
 * NO AfterTool output-rewrite field, so `mutated_output` is dropped on every
 * kind — the same gap `reason` has on Amp. `mutated_input` is dropped everywhere
 * but BeforeTool: the tool has already run by AfterTool, and BeforeAgent has no
 * tool input at all, so emitting `tool_input` there names a channel the host
 * ignores while reading to the caller as a mutation applied.
 *
 * AfterTool is GATED here, so a redaction verdict does reach this adapter and
 * cannot be honoured. It renders {@link POST_TOOL_REDACTION_UNSUPPORTED} on
 * `systemMessage` instead, so the model is told the output above it is
 * unredacted rather than left to read it as vetted. The raw output still reaches
 * the model; a guardrail that must actually redact has to deny.
 * @type {Record<string, ReadonlySet<string>>}
 */
export const UNRENDERED_FIELDS = Object.freeze({
  [EventKind.PRE_TOOL]: Object.freeze(new Set(["mutated_output"])),
  [EventKind.POST_TOOL]: CONTEXT_ONLY,
  [EventKind.PROMPT_SUBMIT]: CONTEXT_ONLY,
  [EventKind.UNKNOWN]: UNRENDERED_ON_UNKNOWN,
});

/**
 * What the model is told when a verdict redacts an AfterTool output Gemini has
 * no channel to replace. Exported so a caller composing its own `systemMessage`
 * can recognize it; recognize it with `endsWith`, never equality, because a
 * verdict carrying `additional_context` too puts that context first (see
 * {@link decisionBody}).
 */
export const POST_TOOL_REDACTION_UNSUPPORTED =
  "The monitor redacted this tool output, but Gemini CLI has no AfterTool " +
  "channel to replace it. Treat the tool output above as UNREDACTED and " +
  "unvetted.";

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
 * builtin name in `tool_name` can only be the builtin. Renaming the tool also
 * renames its INPUT to the schema that name advertises, via
 * {@link GEMINI_INPUT_ALIASES} — a consumer told `event.tool` is `Read` reads
 * `input.file_path` and finds it, rather than reading `undefined` off a
 * forwarded `absolute_path` and allowing. Targets are pinned to
 * {@link MODELED_TOOLS} at import, every entry must be witnessed by a gemini
 * conformance fixture (`assertToolAliasesCovered`), and every aliased case must
 * carry the canonical input key (`assertAliasedInputsCanonical`).
 * @type {Readonly<Record<string, string>>}
 */
// `web_fetch` is deliberately ABSENT. Canonicalizing to `WebFetch` advertises
// `input.url`, and Gemini's payload has no URL field at all — the target sits
// inside a prose `prompt` ("summarize https://example.com"). Recovering it means
// guessing which URL in free text is the target, and a guardrail that gates on a
// guessed destination is worse than one that plainly does not recognize the
// tool: under the alias a domain deny-lister read `input.url`, got `undefined`,
// and allowed the fetch. Left native, `web_fetch` reaches a judge as a name it
// must handle on purpose.
export const GEMINI_TOOL_ALIASES = Object.freeze({
  read_file: "Read",
  write_file: "Write",
});

// Native input field → the canonical field the alias target advertises, per
// tool. Only a pure RENAME belongs here: the value is carried across untouched,
// so no consumer receives a field this adapter invented. A dialect that cannot
// be expressed as a rename does not get an alias at all (see `web_fetch`).
const GEMINI_INPUT_ALIASES = Object.freeze({
  read_file: { absolute_path: "file_path" },
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
 * @param {string|null} nativeTool
 * @param {string} callClass a {@link CallClass} value
 * @returns {Record<string, unknown>}
 */
function geminiInput(kind, raw, nativeTool, callClass) {
  if (kind === EventKind.PROMPT_SUBMIT)
    return { prompt: asString(raw.prompt, "") };
  if (kind !== EventKind.PRE_TOOL && kind !== EventKind.POST_TOOL) return {};
  const input = asObject(raw.tool_input);
  // Renamed only where the NAME was renamed: the aliases are builtin-scoped, so
  // an MCP tool that happens to be called `read_file` keeps its own dialect.
  if (callClass !== CallClass.BUILTIN || nativeTool === null) return input;
  const renames = lookup(GEMINI_INPUT_ALIASES, nativeTool);
  if (renames === undefined) return input;
  const out = { ...input };
  for (const [nativeKey, canonicalKey] of Object.entries(renames)) {
    if (!Object.hasOwn(out, nativeKey)) continue;
    out[canonicalKey] = out[nativeKey];
    delete out[nativeKey];
  }
  return out;
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
    input: geminiInput(kind, raw, nativeTool, callClass),
    response,
    this_call_vetoable: vetoableFor(kind, GATED_EVENTS, COVERAGE[callClass]),
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

  // Enforced deny is a System Block: exit 2, reason carried on STDERR (Gemini
  // reads its block rationale from stderr, not the ignored stdout body). Carry it
  // on NativeResponse.stderr so `emit` writes it to fd 2 — a genuine block is
  // never surfaced to the user/model with no explanation.
  // No stdout body at all on this path, so EVERY content field is dropped here,
  // whatever UNRENDERED_FIELDS says for the kind — that map describes the allow
  // path. Nothing is lost that a blocked call could still use: the tool never
  // runs, so only `additional_context` had anywhere to go.
  if (enforced)
    return nativeResponse({
      transport: INTEGRATION_MODE,
      exit_code: 2,
      enforced: true,
      ...(vd.reason !== undefined ? { stderr: vd.reason } : {}),
    });

  const body =
    event.event === EventKind.PROMPT_SUBMIT
      ? promptSubmitBody(vd)
      : decisionBody(vd, event.event, soleGate);
  return nativeResponse({
    transport: INTEGRATION_MODE,
    exit_code: 0,
    enforced: false,
    ...(body === undefined ? {} : { stdout: body }),
  });
}

/**
 * Write Gemini's advisory `decision: "deny"` (plus any reason) onto `out` for a
 * deny or an ask — Gemini has no native ask tier, so both surface the same way.
 * Shared by both body builders so the two cannot drift apart.
 * @param {Record<string, unknown>} out
 * @param {Verdict} vd
 * @returns {boolean} whether a decision was written
 */
function applyAdvisoryDeny(out, vd) {
  if (vd.decision !== Decision.DENY && vd.decision !== Decision.ASK)
    return false;
  out.decision = "deny";
  if (vd.reason !== undefined) out.reason = vd.reason;
  return true;
}

/**
 * Build the exit-0 stdout decision body. `allow` abstains — no `decision` key,
 * so Gemini runs its normal flow — unless `soleGate` opts into the real
 * `decision: "allow"`. `deny`/`ask` both surface an advisory `decision: "deny"`
 * (Gemini has no native ask tier). `mutated_input` rides along as
 * `hookSpecificOutput.tool_input` on BeforeTool only, and `additional_context`
 * as Gemini's native `systemMessage`. A `mutated_output` has no channel at all:
 * on AfterTool it becomes the {@link POST_TOOL_REDACTION_UNSUPPORTED} warning on
 * that same `systemMessage`, joined after any context the verdict also carries.
 * Returns undefined when there is nothing to emit (a pure abstaining allow).
 * @param {Verdict} vd
 * @param {string} kind the normalized {@link EventKind} being rendered
 * @param {boolean} soleGate
 * @returns {Record<string, unknown>|undefined}
 */
function decisionBody(vd, kind, soleGate) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!applyAdvisoryDeny(out, vd) && soleGate) out.decision = "allow";
  if (kind === EventKind.PRE_TOOL && vd.mutated_input !== undefined)
    out.hookSpecificOutput = { tool_input: vd.mutated_input };
  // `systemMessage` is documented on the TOOL events. An UNKNOWN kind is an
  // event this adapter could not name, so it has no established channel and
  // carries nothing.
  const toolEvent = kind === EventKind.PRE_TOOL || kind === EventKind.POST_TOOL;
  const messages = [];
  if (toolEvent && vd.additional_context !== undefined)
    messages.push(vd.additional_context);
  if (kind === EventKind.POST_TOOL && vd.mutated_output !== undefined)
    messages.push(POST_TOOL_REDACTION_UNSUPPORTED);
  if (messages.length > 0) out.systemMessage = messages.join("\n\n");
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
  applyAdvisoryDeny(out, vd);
  if (vd.additional_context !== undefined)
    out.hookSpecificOutput = { additionalContext: vd.additional_context };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** @type {import("../control-plane.mjs").Adapter} */
export const geminiAdapter = {
  AGENT,
  INTEGRATION_MODE,
  COVERAGE,
  UNRENDERED_FIELDS,
  parse,
  render,
};
