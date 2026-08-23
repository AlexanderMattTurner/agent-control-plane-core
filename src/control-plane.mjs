/**
 * The vendor-neutral control-plane contract.
 *
 * This is the published seam between an agent's native hook/tool-call protocol
 * and claude-guard's guardrails (monitor, deny-match, redaction, sanitizers).
 * It defines TWO normalized shapes — {@link ToolCallEvent} (what an agent is
 * about to / just did) and {@link Verdict} (what the guardrail decided) — plus
 * the {@link Adapter} pair that translates a specific agent's protocol to and
 * from them. Every downstream consumer imports THESE types, never an agent's
 * raw hook JSON; the agent-specific field names live only in that agent's
 * adapter (see adapter-claude.mjs / adapter-codex.mjs).
 *
 * DRIFT DISCIPLINE — the reason the seam earns its keep. An agent protocol
 * drifts additively and independently (N agents, N release cadences). So an
 * adapter's `parse` MUST NOT throw on an event type or tool-input field it does
 * not model: the unmodelled remainder is carried through verbatim (an unknown
 * event becomes {@link EventKind.UNKNOWN} with its native name preserved; extra
 * top-level fields land in `meta.passthrough`). An additive upstream change is
 * then a no-op here, not an outage. The core models ONLY the stable middle:
 * four event kinds, three decisions, and the Bash/Edit/Write/Read/WebFetch tool
 * inputs. Exotic per-agent tools pass through untouched.
 *
 * Dependency-free on purpose, so a fail-closed hook can import it without
 * dragging in eager config-file reads.
 *
 * VERSIONING — this module IS the frozen contract (its own SSOT, no parallel
 * schema file to drift). Adapters and guardrail consumers are built against it
 * in parallel, so its shapes are stable: {@link EventKind}, {@link Decision},
 * {@link MODELED_TOOLS}, and {@link TOOL_ALIASES} are frozen, and
 * {@link SCHEMA_VERSION} / {@link CONTROL_PLANE_SCHEMA} are pinned
 * (control-plane.test.mjs asserts the exact values, so any shape change is a
 * deliberate, reviewed version bump). ADDING to the contract (a new optional
 * field, a new modeled tool, a new tool alias) is backward-compatible and stays
 * at v1; RENAMING or REMOVING a field, or changing a decision/event vocabulary,
 * is breaking and bumps the version.
 */

/** Wire identifier for this schema version; bump on a breaking shape change. */
export const CONTROL_PLANE_SCHEMA = "control-plane/v1";

/** Numeric schema version stamped onto every {@link ToolCallEvent}. */
export const SCHEMA_VERSION = 1;

/**
 * The normalized event kinds the core models. A native event that maps to none
 * of these is carried as {@link EventKind.UNKNOWN} with its native name kept in
 * `meta.native_event`.
 */
export const EventKind = Object.freeze({
  PRE_TOOL: "pre_tool",
  POST_TOOL: "post_tool",
  PROMPT_SUBMIT: "prompt_submit",
  SESSION_START: "session_start",
  UNKNOWN: "unknown",
});

/** @type {Set<string>} the valid {@link EventKind} values, for membership checks. */
const EVENT_KIND_VALUES = new Set(Object.values(EventKind));

/** The normalized verdict decisions a guardrail can return. */
export const Decision = Object.freeze({
  ALLOW: "allow",
  DENY: "deny",
  ASK: "ask",
});

/**
 * Every modeled tool, mapped to the input field a guardrail reads for it — the
 * schema that renaming a native tool to this canonical name ADVERTISES.
 *
 * Canonicalizing the name while passing the native input dialect through is a
 * silent bypass, and the worst kind: a judge written against `Read` reads
 * `input.file_path`, an un-renamed Gemini payload supplies `absolute_path`, so
 * the judge sees `undefined` and allows — having been told by `event.tool` that
 * it was looking at a Read. Leaving the native name would at least fail
 * visibly. `assertAliasedInputsCanonical` holds aliases to this map, so a new
 * alias whose input dialect cannot be renamed faithfully fails conformance
 * instead of shipping as a hole.
 *
 * This is also where {@link MODELED_TOOLS} comes from, rather than a second
 * list beside it. A modeled tool missing its input key would make that guard
 * skip it — re-opening the bypass one tool-add later — and deriving the names
 * from the keys makes the two impossible to drift instead of asking a test to
 * notice.
 */
export const MODELED_TOOL_INPUT_KEYS = Object.freeze({
  Bash: "command",
  Edit: "file_path",
  Write: "file_path",
  Read: "file_path",
  WebFetch: "url",
});

/**
 * Tools whose input shape the core models. Every other tool passes through
 * unmodelled — its input object is preserved verbatim and no field is required.
 */
export const MODELED_TOOLS = Object.freeze(
  Object.keys(MODELED_TOOL_INPUT_KEYS),
);

/** @type {Set<string>} membership set for {@link MODELED_TOOLS}, used to constrain alias targets. */
const MODELED_TOOL_SET = new Set(MODELED_TOOLS);

/**
 * Native-tool-name → canonical {@link MODELED_TOOLS} name. The SSOT that lets a
 * judge key on `event.tool` without a per-agent lookup: an agent whose native
 * name for the shell tool is `run_shell_command` (Gemini) is normalized to the
 * same `Bash` a Claude/Codex/Amp payload already carries, with the raw native
 * name preserved on `meta.native_tool`. Only globally-unambiguous native
 * BUILTIN names belong here — a name that also occurs as an MCP tool (e.g. a
 * `read_file` MCP server) must NOT be aliased, or the normalization would
 * reclassify an unrelated tool. An adapter whose host makes such a name
 * unambiguous at parse time (Gemini's `mcp_{server}_{tool}` FQN discipline)
 * may carry its own ADAPTER-SCOPED alias map instead (see the gemini adapter's
 * `GEMINI_TOOL_ALIASES`), applied only to calls classified BUILTIN. An unknown
 * tool is never in the map, so it passes through verbatim (see
 * {@link canonicalTool}). Every target is a
 * {@link MODELED_TOOLS} member (enforced at load below), and every entry is
 * witnessed by a conformance fixture (see `assertToolAliasesCovered`), so an
 * alias cannot be added without a golden payload that exercises it.
 */
export const TOOL_ALIASES = Object.freeze({
  run_shell_command: "Bash",
});

/**
 * Load-bearing use of MODELED_TOOLS: assert every alias target is a modeled
 * tool, so the alias SSOT can never normalize a native name onto a canon the
 * contract doesn't model. Throws (fail loud) on the first bad target — a typo'd
 * target is a bug, not a silent passthrough. Called at import against
 * {@link TOOL_ALIASES}, and by adapters against their adapter-scoped alias
 * maps; exported so a test can drive both branches.
 * @param {Record<string, string>} aliases
 */
export function assertAliasTargetsModeled(aliases) {
  for (const canonical of Object.values(aliases)) {
    if (!MODELED_TOOL_SET.has(canonical))
      throw new Error(
        `control-plane: tool alias target ${JSON.stringify(canonical)} is not a modeled tool`,
      );
  }
}

assertAliasTargetsModeled(TOOL_ALIASES);

/**
 * Canonicalize a native tool name to its {@link MODELED_TOOLS} equivalent, or
 * return it UNCHANGED when it is not a known alias — an unknown tool is never
 * silently reclassified. `null` (a non-tool event) passes through as `null`.
 * @param {string|null} tool native tool name
 * @returns {string|null} the canonical name, or the native name verbatim
 */
export function canonicalTool(tool) {
  if (typeof tool !== "string") return tool;
  return (
    lookup(/** @type {Record<string, string>} */ (TOOL_ALIASES), tool) ?? tool
  );
}

/**
 * Own-property lookup on an object used as a string-keyed map. Returns the value
 * ONLY when `key` is an OWN property; an inherited `Object.prototype` member
 * (`constructor`, `toString`, `valueOf`, `__proto__`, `hasOwnProperty`, …) that
 * an untrusted key could name resolves to `undefined`, never the prototype
 * function. EVERY map keyed by an untrusted native string — a tool name, an
 * agent id, a native event name — MUST resolve through this: a bare `map[key]`
 * index lets a payload named after a prototype member resolve a JS function
 * instead of falling through to the default, silently reclassifying the call.
 * @template T
 * @param {Record<string, T>} map
 * @param {string} key
 * @returns {T|undefined}
 */
export function lookup(map, key) {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/**
 * How a guardrail ATTACHES to an agent — the transport, kept separate from the
 * normalized decision so the judge/Verdict core stays transport-agnostic:
 *   - EXTERNAL_HOOK: the agent shells out to a hook (stdin JSON → deny body /
 *     exit code). The decision can pre-empt the tool call.
 *   - IN_PROCESS: an embedded analyzer or a driven confirm/reject loop over the
 *     agent's own API. Can pre-empt.
 *   - OBSERVE_ONLY: transcript reader; cannot pre-empt, so its Verdict is
 *     advisory — the hard stop is the sandbox, not the hook.
 */
export const IntegrationMode = Object.freeze({
  EXTERNAL_HOOK: "external_hook",
  IN_PROCESS: "in_process",
  OBSERVE_ONLY: "observe_only",
});

/**
 * The CLASSES of tool call a host may or may not route through its pre-tool
 * guardrail hook. Whether the hook fires is orthogonal to the tool's INPUT shape
 * (which {@link MODELED_TOOLS} covers) — a host can gate its builtin tools while
 * an MCP-sourced or subagent-spawned call of the SAME tool never reaches the
 * hook. Each adapter declares a coverage status per class (see the adapter
 * `COVERAGE` maps and `docs/hook-coverage-matrix.md`); the conformance harness
 * enforces that an uncovered class is never marked `this_call_vetoable`.
 */
export const CallClass = Object.freeze({
  BUILTIN: "builtin",
  MCP: "mcp",
  SUBAGENT: "subagent",
  RESUMED: "resumed",
});

/** Canonical ordered list of {@link CallClass} values — the SSOT every adapter's `COVERAGE` must classify exactly. */
export const CALL_CLASSES = Object.freeze(Object.values(CallClass));

/**
 * Whether a host's pre-tool hook fires for a {@link CallClass} — the machine
 * form of the ✅/❌/⚠️/❓ matrix:
 *   - COVERED (✅): the hook fires for every tool in the class.
 *   - PARTIAL (⚠️): it fires for only SOME tools in the class (e.g. Codex gates
 *     Bash but not other builtins) — a call in the covered subset may be vetoed.
 *   - UNCOVERED (❌): it never fires; the call reaches the tool un-gated.
 *   - UNKNOWN (❓): undocumented — NOT yet proven to fire by a live probe.
 * The doctrine (`docs/hook-coverage-matrix.md`): an UNKNOWN is treated as
 * UNCOVERED until a probe proves ✅, because a guessed ✅ is a silent fail-open.
 */
export const CoverageStatus = Object.freeze({
  COVERED: "covered",
  PARTIAL: "partial",
  UNCOVERED: "uncovered",
  UNKNOWN: "unknown",
});

/** @typedef {"covered"|"partial"|"uncovered"|"unknown"} CoverageStatusValue */
/** @typedef {Record<string, CoverageStatusValue>} CoverageMap a per-{@link CallClass} coverage map (an adapter's `COVERAGE`) */

/** @type {Set<string>} the valid {@link CoverageStatus} values, for membership checks. */
const COVERAGE_STATUS_VALUES = new Set(Object.values(CoverageStatus));

/**
 * Whether a coverage status PERMITS an adapter to mark a call in that class
 * `this_call_vetoable: true`. Only a hook confirmed to fire does: COVERED, or
 * PARTIAL (for the tools in its covered subset). UNCOVERED and UNKNOWN both
 * forbid it — an unknown is fail-closed to uncovered, which is the whole point
 * of the matrix. Throws on an unrecognized status (fail loud — a typo must not
 * quietly read as "permitted").
 *
 * `undefined` is accepted as an INPUT type — that is what a prototype-safe
 * `lookup` of a missing key yields — and takes the same throw: a coverage a
 * caller could not resolve must never read as "permitted" either.
 * @param {string|undefined} status a {@link CoverageStatus} value
 * @returns {boolean}
 */
export function coverageAllowsVeto(status) {
  if (!COVERAGE_STATUS_VALUES.has(/** @type {string} */ (status))) {
    throw new Error(
      `control-plane: invalid coverage status ${JSON.stringify(status)}`,
    );
  }
  return status === CoverageStatus.COVERED || status === CoverageStatus.PARTIAL;
}

/**
 * The event kinds a host can gate at all. {@link EventKind.UNKNOWN} is absent by
 * construction, and that absence is the point: an event this package could not
 * name is one whose host response nobody has established.
 */
/** @type {Set<string>} */
const GATEABLE_KINDS = new Set([
  EventKind.PRE_TOOL,
  EventKind.POST_TOOL,
  EventKind.PROMPT_SUBMIT,
  EventKind.SESSION_START,
]);

/**
 * Whether an event may be marked `this_call_vetoable`.
 *
 * INVARIANT: an event whose kind the adapter's `GATED_EVENTS` does not name is
 * never vetoable, whatever its coverage says. Coverage answers whether the
 * host's hook fires for a CLASS of call and says nothing about a kind the
 * adapter could not model — so keying on coverage alone reported an enforced
 * block for every unmodelled event, which is the one direction that lies to a
 * guardrail: the transcript shows a block and the host runs the tool.
 * @param {string} kind an {@link EventKind} value
 * @param {Set<string>} gatedKinds the adapter's own gated set
 * @param {string|undefined} coverage a {@link CoverageStatus} value
 * @returns {boolean}
 */
export function vetoableFor(kind, gatedKinds, coverage) {
  if (!gatedKinds.has(kind)) return false;
  return coverageAllowsVeto(coverage);
}

/**
 * Refuse a gated-kind set naming a kind no host can gate. Called at module load
 * by each adapter, so `EventKind.UNKNOWN` cannot be added to one by hand.
 * @param {Set<string>} kinds an adapter's `GATED_EVENTS`
 * @param {string} agent the adapter's agent id, for the message
 */
export function assertGatedKinds(kinds, agent) {
  for (const kind of kinds)
    if (!GATEABLE_KINDS.has(kind))
      throw new Error(
        `${agent} adapter: ${JSON.stringify(kind)} is not a gateable event kind`,
      );
}

/**
 * True when `status` is a recognized {@link CoverageStatus} value.
 * @param {unknown} status
 * @returns {boolean}
 */
export function isCoverageStatus(status) {
  return COVERAGE_STATUS_VALUES.has(/** @type {string} */ (status));
}

/**
 * Classify a tool call into a {@link CallClass} from what a single pre-tool
 * payload reveals. Only MCP is reliably detectable here — from the tool NAME
 * (`mcp__server__tool` / `mcp_server_tool`) or an explicit `mcp_context` object
 * on the native payload. Subagent- and resumed-session calls carry no universal
 * signal in a lone pre-tool event (detecting them needs the live probe of
 * item ⑤), so they are NOT distinguished here and fall through to BUILTIN — an
 * adapter whose host leaves those classes un-gated relies on the sandbox, not
 * this classifier. An adapter feeds the result into `coverageAllowsVeto(this.
 * COVERAGE[class])` so a call in an uncovered/unknown class parses non-vetoable.
 * @param {string|null} tool tool name (null for non-tool events)
 * @param {Record<string, unknown>} [native] the raw native payload, for `mcp_context`
 * @returns {string} a {@link CallClass} value
 */
export function classifyCallClass(tool, native) {
  if (typeof tool === "string" && /^mcp__?[^_]/.test(tool))
    return CallClass.MCP;
  const ctx = native ? native.mcp_context : undefined;
  // A plain object mcp_context is the MCP marker; an array is NOT (typeof [] is
  // "object", so a bare typeof test over-classifies an array-valued field as MCP
  // and silently downgrades a legitimate veto).
  if (ctx !== null && typeof ctx === "object" && !Array.isArray(ctx))
    return CallClass.MCP;
  return CallClass.BUILTIN;
}

/**
 * @typedef {object} EventMeta
 * @property {string} agent producing agent id ("claude", "codex", …)
 * @property {string} native_event original native event name, preserved verbatim
 * @property {string} [native_tool] original native tool name, preserved verbatim when `event.tool` was canonicalized (present iff the event carries a tool)
 * @property {"external_hook"|"in_process"|"observe_only"} integration_mode how the guardrail attaches
 * @property {boolean} primary_gate_present the agent's own native gate already ran (⇒ the monitor is a SECOND opinion; the LLM call can be skipped when the native gate already blocked)
 * @property {string} [session_id]
 * @property {string} [cwd]
 * @property {string} [permission_mode]
 * @property {string} [transcript_path]
 * @property {Record<string, unknown>} passthrough unmodelled native top-level fields, verbatim
 */

/**
 * The result of rendering a {@link Verdict} for a specific agent's transport —
 * the ATTACH mechanism, not the decision. A caller applies whichever channels
 * are present: write `stdout`, exit with `exit_code`, or `throw`.
 * @typedef {object} NativeResponse
 * @property {"external_hook"|"in_process"|"observe_only"} transport
 * @property {number} exit_code process exit code carrying the decision (0 = proceed)
 * @property {boolean} enforced whether THIS render actually blocks (false ⇒ advisory only)
 * @property {unknown} [stdout] native JSON body to write to stdout, when the transport uses one
 * @property {string} [stderr] text the host reads from STDERR — the block reason on a transport (e.g. Gemini CLI's exit-2 System Block) that takes its rationale from stderr rather than the stdout body. The caller writes it to fd 2 before exiting.
 */

/**
 * A normalized, agent-agnostic view of one agent event.
 * @typedef {object} ToolCallEvent
 * @property {number} schema_version stamped {@link SCHEMA_VERSION}
 * @property {"pre_tool"|"post_tool"|"prompt_submit"|"session_start"|"unknown"} event
 * @property {string|null} tool CANONICAL tool name — a native alias (e.g. Gemini's `run_shell_command`) is normalized to its {@link MODELED_TOOLS} canon (`Bash`); the raw native name is preserved on `meta.native_tool`. An unknown tool passes through verbatim. null for prompt/session events.
 * @property {Record<string, unknown>} input passthrough tool input; a submitted prompt is folded into `input.prompt`
 * @property {unknown} [response] tool output, post_tool only (string or structured), verbatim
 * @property {boolean} this_call_vetoable false ⇒ the guardrail cannot veto THIS call; a monitor must auto-degrade deny to notify, and any render of it stays advisory (never `enforced`)
 * @property {EventMeta} meta
 */

/**
 * A normalized guardrail decision.
 * @typedef {object} Verdict
 * @property {"allow"|"deny"|"ask"} decision
 * @property {Record<string, unknown>} [mutated_input] replacement tool input (pre_tool)
 * @property {unknown} [mutated_output] replacement tool output (post_tool) — the normalized channel for a PostToolUse content transform (redaction/sanitize); a string or the tool's structured output, verbatim. An adapter renders it into whatever native output-mutation channel the host has, or drops it when the host has none (the same per-adapter fidelity gap `reason` has on Amp).
 * @property {string} [additional_context] extra context to splice into the agent's stream
 * @property {string} [reason] human-readable rationale (shown on deny/ask)
 */

/**
 * The {@link Verdict} fields that carry CONTENT into the agent's stream, as
 * opposed to the decision itself. Every adapter either renders each one into a
 * native channel or has no channel for it and drops it; `UNRENDERED_FIELDS`
 * declares which, and the conformance harness holds each adapter to its own
 * declaration. `reason` is not listed: it is only live on deny/ask, so it is not
 * probeable from a single abstaining verdict the way these three are.
 */
export const VERDICT_CONTENT_FIELDS = Object.freeze([
  "mutated_input",
  "mutated_output",
  "additional_context",
]);

/**
 * The `UNRENDERED_FIELDS` row every adapter uses for {@link EventKind.UNKNOWN}.
 * An event the adapter could not name is one whose host channels nobody
 * established, so claiming any of them is the same fail-open `assertGatedKinds`
 * refuses for the veto: the caller reads a mutation as applied while the host
 * ignores the key it was written into.
 */
export const UNRENDERED_ON_UNKNOWN = Object.freeze(
  new Set(VERDICT_CONTENT_FIELDS),
);

/**
 * The translator for one agent's protocol. `parse` maps a native event to a
 * {@link ToolCallEvent} (never throwing on unmodelled input, stamping the
 * integration mode / enforcement flags on `meta`); `render` maps a {@link Verdict}
 * to that agent's native transport ({@link NativeResponse}), not just a JSON body.
 * @typedef {object} Adapter
 * @property {string} AGENT
 * @property {"external_hook"|"in_process"|"observe_only"} INTEGRATION_MODE
 * @property {Record<string, "covered"|"partial"|"uncovered"|"unknown">} COVERAGE per-{@link CallClass} hook-coverage status; must classify every {@link CALL_CLASSES} entry
 * @property {(native: any) => ToolCallEvent} parse
 * @property {(verdict: Verdict, event: ToolCallEvent, options?: { soleGate?: boolean }) => NativeResponse} render
 * @property {Record<string, ReadonlySet<string>|undefined>} UNRENDERED_FIELDS per-event-kind set of {@link VERDICT_CONTENT_FIELDS} this host has no native channel for, so `render` drops them. EVERY {@link EventKind} carries a row, including one this adapter's `parse` cannot emit — an omission would otherwise read as "every content field reaches a channel here", the reverse of the truth on a transport that carries none. The value type still admits `undefined` so a consumer handles a lookup miss rather than indexing straight into `.has(...)`; the conformance harness refuses a missing row. The conformance harness fails an adapter whose renders disagree with its declaration either way, so a stale entry cannot survive.
 */

/**
 * Build a normalized {@link ToolCallEvent}, stamping the schema version. Pure —
 * adapters pass already-normalized parts. `response` is omitted unless defined
 * so a pre_tool event has no `response` key at all.
 * @param {{ event: string, tool: string|null, input: Record<string, unknown>, response?: unknown, this_call_vetoable: boolean, meta: EventMeta }} parts
 * @returns {ToolCallEvent}
 */
export function makeEvent({
  event,
  tool,
  input,
  response,
  this_call_vetoable,
  meta,
}) {
  // Fail loud on an internally-malformed event: an adapter that hands makeEvent a
  // typo'd event kind ("pre-tool") or a non-boolean vetoable flag would otherwise
  // ship an event that downstream `switch(event)` and the `=== false` veto-honesty
  // guard silently mis-handle (a non-boolean `this_call_vetoable` reads as
  // vetoable — a fail-open seam). These are produced in-process, so a bad value is
  // a bug, not untrusted input to tolerate.
  if (!EVENT_KIND_VALUES.has(event))
    throw new Error(
      `control-plane: makeEvent got an unmodeled event kind ${JSON.stringify(event)} (use EventKind.UNKNOWN for an unmapped native event)`,
    );
  if (typeof this_call_vetoable !== "boolean")
    throw new TypeError(
      `control-plane: makeEvent this_call_vetoable must be a boolean, got ${typeof this_call_vetoable}`,
    );
  // The same fail-open seam, one step further: an event the adapter could not
  // name is one whose host response nobody established, so a veto reported for
  // it is a block the render claims and the host never performs. Refused HERE
  // because every adapter builds its event through this call, so an adapter that
  // computes the flag without `vetoableFor` cannot reach the wire either.
  if (event === EventKind.UNKNOWN && this_call_vetoable)
    throw new Error(
      "control-plane: makeEvent got a vetoable UNKNOWN event — an unmodelled " +
        "event has no host response to veto, so reporting one is a false block",
    );
  /** @type {ToolCallEvent} */
  const evt = {
    schema_version: SCHEMA_VERSION,
    event: /** @type {ToolCallEvent["event"]} */ (event),
    tool,
    input,
    this_call_vetoable,
    meta,
  };
  if (response !== undefined) evt.response = response;
  return evt;
}

/**
 * Validate and normalize a {@link Verdict}. The decision must be one of
 * allow/deny/ask — a verdict is produced internally, so an out-of-range
 * decision is a bug and throws (fail loud), unlike the pass-through tolerance
 * `parse` extends to untrusted upstream events. Returns a fresh object carrying
 * only the modeled optional fields that are present; never mutates its input.
 * @param {Verdict} verdict
 * @returns {Verdict}
 */
export function normalizeVerdict(verdict) {
  const { decision } = verdict;
  if (
    decision !== Decision.ALLOW &&
    decision !== Decision.DENY &&
    decision !== Decision.ASK
  ) {
    throw new Error(
      `control-plane: invalid verdict decision ${JSON.stringify(decision)}`,
    );
  }
  /** @type {Verdict} */
  const out = { decision };
  if (verdict.mutated_input !== undefined)
    out.mutated_input = verdict.mutated_input;
  if (verdict.mutated_output !== undefined)
    out.mutated_output = verdict.mutated_output;
  if (verdict.additional_context !== undefined)
    out.additional_context = verdict.additional_context;
  if (verdict.reason !== undefined) out.reason = verdict.reason;
  return out;
}

/**
 * Render an untrusted, rejected `decision` value for the clamp note. Prefers the
 * JSON form (so a string reads back quoted, matching the note's contract) but
 * falls back to `String(...)` for a value JSON cannot serialize — a BigInt would
 * otherwise make `JSON.stringify` THROW, defeating the whole fail-to-ask purpose
 * of the clamp on exactly the malformed input it exists to neutralize.
 * @param {unknown} decision
 * @returns {string}
 */
function stringifyRejected(decision) {
  try {
    return JSON.stringify(decision) ?? String(decision);
  } catch {
    return String(decision);
  }
}

/**
 * Harden an UNTRUSTED {@link Verdict} — one authored by a separate
 * monitor/judge process (e.g. claude-guard's scrub-monitor-response) — before
 * it is rendered. Two defenses:
 *
 *   1. Decision clamp (fail-to-ask): a `decision` outside allow/deny/ask
 *      becomes `"ask"`, and the clamp is made observable by appending a
 *      bracketed note to `reason` naming the rejected value — a malformed
 *      monitor answer escalates to a human instead of throwing (the internal
 *      strictness of {@link normalizeVerdict}) or silently allowing.
 *   2. Text scrubbing: the caller-supplied `sanitizeText` runs over every
 *      monitor-authored PROSE field present — `reason` and
 *      `additional_context` (a non-string value in either is dropped; prose
 *      channels carry strings). `mutated_input`/`mutated_output` are NOT
 *      sanitized: they are data channels (replacement tool input/output the
 *      guardrail computed, often deliberately containing the very bytes a text
 *      scrubber would mangle), not monitor-authored prose. `mutated_input` is
 *      shape-checked only (a non-object is dropped — see the inline note);
 *      `mutated_output` is carried verbatim.
 *
 * `sanitizeText` is injected so this module stays dependency-free. It must be
 * a function and must return a string — a sanitizer that eats the value is a
 * bug, so a non-string return throws. Returns a fresh normalized verdict;
 * never mutates its input.
 * @param {unknown} verdict the untrusted verdict object
 * @param {(text: string) => string} sanitizeText
 * @returns {Verdict}
 */
export function sanitizeVerdict(verdict, sanitizeText) {
  if (typeof sanitizeText !== "function") {
    throw new TypeError(
      "control-plane: sanitizeVerdict requires a sanitizeText(string) => string function",
    );
  }
  const raw = asObject(verdict);
  /** @type {(field: string, value: string) => string} */
  const scrub = (field, value) => {
    const out = sanitizeText(value);
    if (typeof out !== "string") {
      throw new TypeError(
        `control-plane: sanitizeText returned a non-string for ${field} — a sanitizer must return the sanitized text`,
      );
    }
    return out;
  };
  const { decision } = raw;
  const valid =
    decision === Decision.ALLOW ||
    decision === Decision.DENY ||
    decision === Decision.ASK;
  /** @type {Verdict} */
  const out = {
    decision: /** @type {Verdict["decision"]} */ (
      valid ? decision : Decision.ASK
    ),
  };
  // mutated_input must be a plain object (it replaces a tool's input); a
  // malformed value is dropped rather than coerced — an empty {} substitute
  // would silently blank the tool call. mutated_output is unconstrained by the
  // contract, so it is carried verbatim.
  const mutatedInput = raw.mutated_input;
  if (
    mutatedInput !== undefined &&
    mutatedInput !== null &&
    typeof mutatedInput === "object" &&
    !Array.isArray(mutatedInput)
  )
    out.mutated_input = /** @type {Record<string, unknown>} */ (mutatedInput);
  if (raw.mutated_output !== undefined) out.mutated_output = raw.mutated_output;
  if (typeof raw.additional_context === "string")
    out.additional_context = scrub(
      "additional_context",
      raw.additional_context,
    );
  if (typeof raw.reason === "string") out.reason = scrub("reason", raw.reason);
  if (!valid) {
    // The rejected value is itself untrusted text, so it is scrubbed before
    // being embedded in the clamp note.
    const rejected = scrub("decision", stringifyRejected(decision));
    const note = `[control-plane: invalid verdict decision ${rejected} clamped to "ask"]`;
    out.reason = out.reason === undefined ? note : `${out.reason} ${note}`;
  }
  return normalizeVerdict(out);
}

/**
 * Return a shallow copy of `native` with the `consumed` keys removed — the
 * unmodelled remainder an adapter carries in `meta.passthrough` so an additive
 * upstream field survives instead of being silently dropped.
 * @param {Record<string, unknown>} native
 * @param {Set<string>} consumed
 * @returns {Record<string, unknown>}
 */
export function collectPassthrough(native, consumed) {
  /** @type {Record<string, unknown>} */
  const rest = {};
  for (const [key, val] of Object.entries(native)) {
    if (!consumed.has(key)) rest[key] = val;
  }
  return rest;
}

// ─── Coercion primitives ─────────────────────────────────────────────────────
// Adapters read untrusted native JSON: a field may be absent, null, or the wrong
// type. These coerce to a safe shape (never throw) so a malformed field degrades
// to a well-defined default instead of taking the parse down.

/**
 * The value if it is a plain (non-array) object, else `{}`.
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * The value if it is a string, else `null`.
 * @param {unknown} value
 * @returns {string|null}
 */
export function asStringOrNull(value) {
  return typeof value === "string" ? value : null;
}

/**
 * The value if it is a string, else `fallback`.
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
export function asString(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

/**
 * Assemble a {@link NativeResponse}, omitting an absent `stdout` so a pure
 * exit-code transport carries no `stdout` key.
 * @param {{ transport: string, exit_code: number, enforced: boolean, stdout?: unknown, stderr?: string }} parts
 * @returns {NativeResponse}
 */
export function nativeResponse({
  transport,
  exit_code,
  enforced,
  stdout,
  stderr,
}) {
  /** @type {NativeResponse} */
  const out = {
    transport: /** @type {NativeResponse["transport"]} */ (transport),
    exit_code,
    enforced,
  };
  if (stdout !== undefined) out.stdout = stdout;
  if (stderr !== undefined) out.stderr = stderr;
  return out;
}
