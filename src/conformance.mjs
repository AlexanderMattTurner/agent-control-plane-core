import {
  CALL_CLASSES,
  Decision,
  EventKind,
  IntegrationMode,
  MODELED_TOOL_INPUT_KEYS,
  TOOL_ALIASES,
  canonicalTool,
  coverageAllowsVeto,
  isCoverageStatus,
  lookup,
  VERDICT_CONTENT_FIELDS,
} from "./control-plane.mjs";

/**
 * The two probe verdicts rule ⑧ renders against a non-vetoable variant of each
 * pre-tool fixture event. Frozen so a mutating adapter cannot poison later cases.
 */
const UNENFORCEABLE_DENY_PROBE = Object.freeze({
  decision: Decision.DENY,
  reason: "conformance probe: unenforceable deny",
});
const ABSTAINING_ALLOW_PROBE = Object.freeze({ decision: Decision.ALLOW });

/**
 * The payload rule ⑨ drifts an adapter with. No host emits that event name, so
 * an adapter that maps event names must answer {@link EventKind.UNKNOWN}.
 *
 * `version` carries a release far past any adapter's enforcement floor. Without
 * it Codex's own version gate answers non-vetoable for an unrelated reason, and
 * the rule then passes on the adapter that needs it most — Codex routes EVERY
 * non-PreToolUse event into UNKNOWN, so a probe it cannot bite on certifies
 * nothing.
 */
const DRIFT_PROBE_NATIVE = Object.freeze({
  hook_event_name: "ConformanceProbeUnmodelledEvent",
  version: "9999.0.0",
});

/**
 * The value rule ⑩ puts in each content field it probes, and the shapes each
 * field's contract allows it to take (`mutated_input` must be an object). It is
 * a sentinel rather than realistic content because the rule asks whether the
 * VALUE reached the wire, which is answered by searching the serialized render
 * for it — a check that survives an adapter wrapping, renaming or annotating the
 * channel, where comparing two whole renders does not.
 */
const CONTENT_PROBE_SENTINEL = "acpc-conformance-content-probe-b6f1";

/**
 * `meta.native_event` on a synthesized probe event — a name no host uses, so an
 * adapter that selects its output schema from that field takes its
 * unrecognized-event branch rather than a fallback naming a real one.
 */
const PROBE_NATIVE_EVENT = "acpc-conformance-synthesized-event";

/**
 * The `ReadonlySet` members an `UNRENDERED_FIELDS` row must carry. A consumer
 * reads a row every way a Set can be read, so a row that answers only `has` is
 * a crash waiting for the first caller that iterates it.
 */
const SET_SURFACE = Object.freeze([
  "has",
  "forEach",
  "keys",
  "values",
  "entries",
  Symbol.iterator,
]);
/** One field's sentinel — distinct per field, so a probe carrying several can
 * say WHICH of them reached the wire. */
const sentinelFor = (/** @type {string} */ field) =>
  `${CONTENT_PROBE_SENTINEL}-${field}`;

/** JSON-shaped deep equality, for comparing one render against another. */
const same = (/** @type {unknown} */ a, /** @type {unknown} */ b) =>
  JSON.stringify(a) === JSON.stringify(b);

const isBranch = (/** @type {unknown} */ v) =>
  v !== null && typeof v === "object";

/**
 * Every path at which RENDERS do not all agree, outermost first.
 *
 * A path that varies with the value is a position the field could be reaching;
 * one that does not vary cannot be, which is what drops a warning keyed on the
 * field's presence out of the comparison.
 *
 * ANCESTORS are included, not only the innermost disagreements: a structured
 * value sits at the path whose CHILDREN differ, so returning the children alone
 * would never offer the position holding the whole value.
 */
/**
 * @param {unknown[]} renders
 * @param {string[]} path
 * @returns {string[][]}
 */
const divergences = (renders, path = []) => {
  const [first, ...rest] = renders;
  if (rest.every((r) => same(r, first))) return [];
  const alike =
    renders.every(isBranch) &&
    renders.every((r) => Array.isArray(r) === Array.isArray(first));
  if (!alike) return [path];
  const keys = [
    ...new Set(renders.flatMap((r) => Object.keys(/** @type {any} */ (r)))),
  ];
  return [
    path,
    ...keys.flatMap((key) =>
      divergences(
        renders.map((r) => /** @type {any} */ (r)[key]),
        [...path, key],
      ),
    ),
  ];
};

/** What RENDER holds at PATH. */
const at = (/** @type {unknown} */ render, /** @type {string[]} */ path) =>
  path.reduce((node, key) => /** @type {any} */ (node)?.[key], render);

/**
 * The values each content field is probed with — every shape its contract
 * allows, and at least TWO per field, because the rule reads a field's channel
 * off the positions that VARY as the value changes.
 *
 * A sentinel rides in the VALUE, never a key: an adapter forwarding an input's
 * key set while dropping the values would serialize a sentinel KEY and pass,
 * which is the self-consistent broken render this rule exists to catch
 * independently of the golden fixtures. The values that hold no sentinel at all
 * are carried by the same structural comparison.
 */
// Fields the contract carries VERBATIM, so a native path must hold the value
// itself. `additional_context` is not one: it is prose for the model, and a
// host with one message channel may legitimately COMPOSE it with its own text —
// gemini joins it with the post-tool warning. That field only has to reach the
// wire intact somewhere inside a varying path.
const CARRIED_VERBATIM = Object.freeze(["mutated_input", "mutated_output"]);

const CONTENT_PROBE_VALUES = Object.freeze({
  // A `Verdict`'s `mutated_input` is any `Record<string, unknown>`, not a Bash
  // call: a Read/Edit/Write replacement carries `file_path` and no `command`,
  // and an EMPTY record is a legitimate replacement too. An adapter that
  // forwards only what looks like a shell invocation drops the rest.
  mutated_input: Object.freeze([
    Object.freeze({ command: sentinelFor("mutated_input") }),
    Object.freeze({ command: `${sentinelFor("mutated_input")}-2`, argv: [] }),
    Object.freeze({ file_path: sentinelFor("mutated_input") }),
    Object.freeze({}),
  ]),
  // `mutated_output` is a tool's output verbatim, so every JSON shape a tool
  // can return is one an adapter must forward. A render that type-switches
  // passes the shapes it happens to handle and drops the rest, and the EMPTY
  // ones are what an `if (verdict.mutated_output)` render loses — an empty
  // output being how a redaction removes all content.
  mutated_output: Object.freeze([
    sentinelFor("mutated_output"),
    Object.freeze({ content: sentinelFor("mutated_output") }),
    Object.freeze([Object.freeze({ text: sentinelFor("mutated_output") })]),
    null,
    true,
    false,
    "",
    0,
    Object.freeze({}),
    Object.freeze([]),
    908172635441,
  ]),
  additional_context: Object.freeze([
    sentinelFor("additional_context"),
    `${sentinelFor("additional_context")}-2`,
  ]),
});

// A field added to VERDICT_CONTENT_FIELDS with no probe value would be dropped
// by normalizeVerdict and then reported as "reaches no native channel" against
// every adapter, naming the adapter for the harness's own omission.
if (
  VERDICT_CONTENT_FIELDS.some(
    (field) => (lookup(CONTENT_PROBE_VALUES, field) ?? []).length < 2,
  )
)
  throw new Error(
    `conformance: CONTENT_PROBE_VALUES needs two or more values for each of ${VERDICT_CONTENT_FIELDS.join(", ")}`,
  );

/**
 * Rule ⑩'s first half: the adapter declares a row for EVERY {@link EventKind}.
 *
 * Iterated over the SSOT rather than over the fixtures, because a kind an
 * adapter's `parse` never emits is exactly the one whose row goes missing — and
 * an absent row reads as "every content field reaches a channel here", which is
 * the reverse of the truth on a transport that carries none. Gemini's
 * `session_start` and Amp's `unknown` are the live cases: no fixture produces
 * either, so a fixture-driven check certifies neither.
 * @param {import("./control-plane.mjs").Adapter} adapter
 * @param {any} assert
 */
function assertEveryKindHasARow(adapter, assert) {
  // An adapter written against the earlier contract has no map at all, and
  // `lookup` would throw a bare TypeError on it. Name the missing member and its
  // one-line migration instead — a third-party adapter's author is who reads
  // this, and a stack trace into the harness tells them nothing.
  assert.ok(
    adapter.UNRENDERED_FIELDS !== null &&
      typeof adapter.UNRENDERED_FIELDS === "object",
    `${adapter.AGENT}: adapter declares no UNRENDERED_FIELDS — every adapter needs one row per EventKind naming the VERDICT_CONTENT_FIELDS this host has no channel for (UNRENDERED_ON_UNKNOWN for a kind that carries none, readonlySet([]) for one that carries all three)`,
  );
  // The MAP, not only its rows: a consumer that can swap the row for `pre_tool`
  // rewrites the declaration after conformance certifies it, which is the same
  // corruption immutable rows exist to prevent, one level out.
  assert.ok(
    Object.isFrozen(adapter.UNRENDERED_FIELDS),
    `${adapter.AGENT}: UNRENDERED_FIELDS is not frozen — a consumer can replace a whole row after conformance certifies it; wrap the map in Object.freeze`,
  );
  for (const kind of Object.values(EventKind)) {
    const row = lookup(adapter.UNRENDERED_FIELDS, kind);
    assert.ok(
      row !== undefined,
      `${adapter.AGENT}: UNRENDERED_FIELDS has no row for '${kind}' — every EventKind needs one, so an omission cannot read as full support`,
    );
    // A row is only a declaration if it answers like the ReadonlySet the
    // contract promises. `null` reads as "declares nothing" at every `has` call,
    // so the adapter claims every channel; `{ has: () => true }` passes a
    // has-only check while a consumer that iterates it, or reads `size`, fails
    // at runtime.
    assert.ok(
      SET_SURFACE.every(
        (member) => typeof (/** @type {any} */ (row)?.[member]) === "function",
      ) && typeof (/** @type {any} */ (row)?.size) === "number",
      `${adapter.AGENT}: UNRENDERED_FIELDS row for '${kind}' is not a ReadonlySet — use readonlySet([...]), which carries ${SET_SURFACE.length} members plus size`,
    );
    // The members are not the contract, the SEMANTICS are: a Map carries every
    // one of them and hands a consumer `[key, value]` pairs. Iterating has to
    // yield the declared field names themselves, agree with `has`, and count
    // `size` — and each name has to be a field a Verdict actually carries, or a
    // typo declares nothing while reading as a declaration.
    assertRowReads(adapter.AGENT, kind, row, assert);
  }
}

/**
 * One `UNRENDERED_FIELDS` row, read every way a `ReadonlySet` can be read.
 *
 * The members are not the contract, the semantics are: a `Map` carries all of
 * them and hands a consumer `[key, value]` pairs, and a row whose `forEach`
 * throws passes any check that only asks whether it is callable. Every reader
 * has to answer the same field names, each name has to be a field a `Verdict`
 * carries, and `size` has to count them — a typo like `mutatedOutput` otherwise
 * declares nothing while reading as a declaration.
 * @param {string} agent
 * @param {string} kind
 * @param {any} row
 * @param {any} assert
 */
function assertRowReads(agent, kind, row, assert) {
  const where = `${agent}: UNRENDERED_FIELDS row for '${kind}'`;
  const declared = [...row];
  assert.equal(
    new Set(declared).size,
    declared.length,
    `${where} iterates a value twice — a set has each of its members once`,
  );
  // A row must be immutable, not merely read-only-looking. `Object.freeze` does
  // NOT stop `new Set([...]).clear()`, so a certified row could be emptied
  // afterwards and would then report channels `render` still drops — the stale
  // declaration this whole rule exists to prevent. `readonlySet` exposes no
  // mutator at all, which is what makes every call below throw.
  //
  // Throwing is not enough on its own: a mutator that inserts and THEN throws
  // has already changed the row, and a caller who catches it observes the new
  // contents. So the members are compared across every attempt.
  for (const [mutator, argument] of [
    ["add", "mutated_input"],
    ["delete", declared[0]],
    ["clear", undefined],
  ]) {
    assert.throws(
      () => /** @type {any} */ (row)[mutator](argument),
      `${where} exposes a working '${mutator}' — a consumer can rewrite the declaration after conformance certifies it; build the row with readonlySet`,
    );
    assert.deepEqual(
      [...row],
      declared,
      `${where}: '${mutator}' changed the row before it threw — a caller that catches it reads the new declaration`,
    );
  }
  assert.deepEqual(
    declared.filter((field) => VERDICT_CONTENT_FIELDS.includes(field)),
    declared,
    `${where} does not iterate as a set of ${VERDICT_CONTENT_FIELDS.join("/")} — got ${JSON.stringify(declared)}`,
  );
  // `has` has to answer for EVERY content field, not only the iterated ones:
  // a row that iterates one field while `has` says yes to all three tells rule
  // ⑩ one declaration and a consumer that iterates it another.
  assert.deepEqual(
    VERDICT_CONTENT_FIELDS.filter((field) => row.has(field)),
    VERDICT_CONTENT_FIELDS.filter((field) => declared.includes(field)),
    `${where}: has() and iteration disagree about ${VERDICT_CONTENT_FIELDS.join("/")}`,
  );
  assert.equal(declared.length, row.size, `${where} miscounts its own size`);
  assert.deepEqual([...row.keys()], declared, `${where}: keys() disagrees`);
  assert.deepEqual([...row.values()], declared, `${where}: values() disagrees`);
  assert.deepEqual(
    [...row.entries()],
    declared.map((field) => [field, field]),
    `${where}: entries() is not a set's [value, value]`,
  );
  /** @type {string[][]} */
  const walked = [];
  /** @type {unknown[]} */
  const handed = [];
  row.forEach(
    (
      /** @type {string} */ value,
      /** @type {string} */ key,
      /** @type {any} */ set,
    ) => {
      walked.push([value, key]);
      handed.push(set);
    },
  );
  assert.deepEqual(
    walked,
    declared.map((field) => [field, field]),
    `${where}: forEach does not pass (value, value)`,
  );
  // The third argument is the row ITSELF, by identity. A row that hands the
  // callback its private inner collection gives a consumer a handle the frozen
  // facade exists to withhold, and a look-alike carrying the same readers
  // compares equal while hiding its own mutable state — so `===`, not equality.
  assert.equal(
    handed.length,
    declared.length,
    `${where}: forEach called its callback ${handed.length} times for ${declared.length} members`,
  );
  assert.ok(
    handed.every((set) => set === row),
    `${where}: forEach does not pass the row itself as its third argument`,
  );
}

/**
 * Rule ⑩'s other half: every declared row agrees with what `render` emits.
 *
 * Existence is not agreement. A row for a kind no fixture produces could claim
 * a channel the render drops, and the per-fixture probes would never ask.
 * @param {import("./control-plane.mjs").Adapter} adapter
 * @param {Record<string, import("./control-plane.mjs").ToolCallEvent>} byKind one parsed event per kind a fixture produced
 * @param {any} assert
 * @param {Set<string>} seen fields observed to REACH a wire
 */
function assertEveryKindRenders(adapter, byKind, assert, seen) {
  for (const kind of Object.values(EventKind))
    assertContentChannels(
      adapter,
      lookup(byKind, kind) ?? coherentEvent(adapter, byKind, kind),
      `every-kind probe '${kind}'`,
      assert,
      seen,
    );
}

/**
 * A representative event OF `kind`, preferring one a fixture actually produced.
 *
 * Re-labelling a parsed event is not enough: a `pre_tool` event relabelled
 * `prompt_submit` still carries a `tool` the contract says is null there, and
 * still names `PreToolUse` on `meta.native_event` — so an adapter that picks its
 * native schema from that field would be probed about the wrong channel. The
 * synthesized event drops what the kind cannot carry, and names
 * {@link PROBE_NATIVE_EVENT} rather than a real native event it is not.
 *
 * `NATIVE_EVENT_FOR` is the adapter's own answer for that field, so a render
 * that selects its output schema from the native name takes the branch this
 * kind really takes. {@link PROBE_NATIVE_EVENT} is the fallback for a kind the
 * adapter names no native event for — `unknown` by definition, and any kind its
 * transport does not carry. The marker is a value rather than an absence
 * because `parse` always stamps this field: reading `undefined` sends a
 * renderer down a fallback no real event reaches, and Codex's names
 * `PreToolUse`.
 * @param {import("./control-plane.mjs").Adapter} adapter
 * @param {Record<string, import("./control-plane.mjs").ToolCallEvent>} byKind
 * @param {string} kind
 * @returns {import("./control-plane.mjs").ToolCallEvent}
 */
function coherentEvent(adapter, byKind, kind) {
  const carriesTool =
    kind === EventKind.PRE_TOOL || kind === EventKind.POST_TOOL;
  // A tool kind seeded from a prompt/session event inherits `tool: null` and
  // that event's input, which is an event no `parse` produces. Prefer a
  // tool-bearing one; the first parsed event is the fallback.
  const preferred = carriesTool
    ? (lookup(byKind, EventKind.PRE_TOOL) ??
      lookup(byKind, EventKind.POST_TOOL))
    : undefined;
  const seed = preferred ?? Object.values(byKind)[0];
  // `native_tool` names the tool this event is about, so a kind that carries no
  // tool must not carry it either — an event `parse` never produces.
  const { native_tool, ...seedMeta } = seed.meta ?? {};
  const meta = {
    ...seedMeta,
    ...(carriesTool && native_tool !== undefined ? { native_tool } : {}),
    native_event:
      lookup(adapter.NATIVE_EVENT_FOR ?? {}, kind) ?? PROBE_NATIVE_EVENT,
  };
  const { response, ...rest } = seed;
  void response;
  return {
    ...rest,
    event: /** @type {any} */ (kind),
    // A synthesized event is one no fixture produced, so nothing here says this
    // adapter gates this kind — Amp seeds every other kind from its vetoable
    // `pre_tool` fixture and can gate none of them. Claiming enforcement would
    // report a block the host never performs, which `makeEvent` refuses outright
    // for UNKNOWN. Rule ⑧ probes the non-vetoable deny path on its own.
    this_call_vetoable: false,
    tool: carriesTool ? seed.tool : null,
    input: carriesTool ? seed.input : {},
    ...(kind === EventKind.POST_TOOL && "response" in seed
      ? { response: seed.response }
      : {}),
    meta: /** @type {any} */ (meta),
  };
}

/**
 * Rule ⑩, for one parsed event: every {@link VERDICT_CONTENT_FIELDS} entry
 * either reaches this host's wire or is DECLARED unreachable in the adapter's
 * `UNRENDERED_FIELDS`, and the render agrees with the declaration both ways.
 *
 * The gap this closes is silent loss. Three adapters carry a `Verdict` field no
 * native channel accepts — Gemini and Codex have no output-rewrite field, Amp
 * has no stdout body at all — and each simply ignored it, so a redaction verdict
 * rendered a bare allow and the unredacted output reached the model with nothing
 * anywhere saying so. Declaring the drop is what makes it reviewable; checking
 * the declaration against the render is what stops it going stale, in the
 * direction that matters most (a channel that quietly stops carrying a field
 * reads as a working redaction).
 *
 * Probed on a synthesized verdict rather than a fixture, for rule ⑧'s reason: an
 * adapter with no channel for a field has no fixture to write for it, so a
 * fixture-driven check would sit vacuous on exactly the adapters the rule is
 * for.
 *
 * SCOPE — the probe carries an abstaining `allow`, so the declaration this rule
 * checks is about the ALLOW path. An enforced deny may legitimately drop more:
 * Gemini's exit-2 System Block returns no stdout body at all, so a deny there
 * carries no context whatever `UNRENDERED_FIELDS` says. Widening the map to
 * (kind, decision) would state that, and is not worth its weight while the only
 * field a blocked call can still want is `additional_context`.
 *
 * Reaching the wire is checked as SERIALIZATION, so the rule proves a field is
 * carried, not that the key it is carried in is one the host reads. Nothing
 * machine-readable describes a host's schema, so that half stays with the
 * declaration's prose and its review.
 * @param {import("./control-plane.mjs").Adapter} adapter
 * @param {import("./control-plane.mjs").ToolCallEvent} event
 * @param {string} caseName
 * @param {any} assert
 * @param {Set<string>} seen fields observed to REACH a wire, for the non-vacuity check
 */
function assertContentChannels(adapter, event, caseName, assert, seen) {
  const declared = lookup(adapter.UNRENDERED_FIELDS, event.event);

  // Every value of a field is rendered and the renders compared to EACH OTHER.
  // A path that varies with the value is a position the field reaches, and ONE
  // such path must hold every value VERBATIM — same type, same structure, not
  // merely a marker somewhere inside it.
  //
  // ONE path, not all of them: a native schema may annotate the output it
  // carries with a type discriminator or a length, and that metadata varies
  // with the value while equalling none of them. Requiring every varying path
  // to hold the value would reject the adapter for describing what it carried.
  //
  // Comparing values to each other is what drops behaviour keyed on the field's
  // PRESENCE — gemini's post-tool warning — out of the comparison: it is
  // identical at every value, so no path varies with it. A diff against the
  // field-absent render would score that declared drop as "carried".
  //
  // HELD carries the other content fields, constant across the renders, so an
  // adapter that loses this one only when another shares the channel has
  // nowhere to hide.
  /** @param {string} field @param {Record<string, unknown>} held @param {string} shape */
  const carries = (field, held, shape) => {
    const values = lookup(CONTENT_PROBE_VALUES, field) ?? [];
    if (values.length < 2) return;
    const renders = values.map((value) =>
      adapter.render(
        { decision: Decision.ALLOW, ...held, [field]: value },
        event,
      ),
    );
    const paths = divergences(renders);
    const where = `'${caseName}' (${adapter.AGENT}), ${field} ${shape}`;
    if (declared?.has(field)) {
      assert.deepEqual(
        paths,
        [],
        `${where}: UNRENDERED_FIELDS declares ${field} has no channel on ${event.event}, but the render changes with its value`,
      );
      return;
    }
    assert.ok(
      paths.length,
      `${where}: ${field} reaches no native channel on ${event.event}, though the row declares one — the verdict is silently lost`,
    );
    const verbatim = CARRIED_VERBATIM.includes(field);
    /** Does PATH hold the value the verdict set for probe INDEX? */
    const holdsAt = (
      /** @type {string[]} */ path,
      /** @type {number} */ index,
    ) => {
      const found = at(renders[index], path);
      const value = values[index];
      if (verbatim) return same(found, value);
      return (
        typeof found === "string" &&
        typeof value === "string" &&
        found.includes(value)
      );
    };
    // A host may split its channels by SHAPE — text at one native key,
    // structured results at another — so the values need not share one path.
    // Each path must carry at least TWO of them, which is what stops an
    // unrelated varying key from claiming a single value by coincidence: a
    // render that drops the output while emitting `has_output: false` holds the
    // `false` probe there and nothing else.
    const channels = paths
      .map((path) => values.map((_, index) => holdsAt(path, index)))
      .filter(
        (held) => held.filter(Boolean).length >= Math.min(2, values.length),
      );
    const missing = values.findIndex(
      (_, index) => !channels.some((held) => held[index]),
    );
    if (missing === -1) {
      seen.add(field);
      return;
    }
    // One value reached no channel. Name it at the INNERMOST varying position,
    // which is the one a reader can act on.
    const path = paths[paths.length - 1];
    const index = missing;
    assert.fail(
      `${where}: no native path carries ${field} ${verbatim ? "verbatim" : "intact"} on ${event.event}. At ${path.join(".") || "the render root"} the render holds ${JSON.stringify(at(renders[index], path))} where the verdict set ${JSON.stringify(values[index])}`,
    );
  };

  for (const field of VERDICT_CONTENT_FIELDS) {
    carries(field, {}, "alone");
    // The HELD fields take every COMBINATION of their shapes, because an
    // adapter can lose one channel only for a particular pairing of the other
    // two — dropping the context exactly when the input is a record and the
    // output an object. Zipping the held lists by index reaches each held
    // field's every shape but only one pairing of them.
    //
    // The cross-product is 264 renders per case over three fields today, and
    // `render` is a pure call. A fourth content
    // field would multiply that, and is the point to reconsider.
    const others = VERDICT_CONTENT_FIELDS.filter((name) => name !== field);
    const held = others.reduce(
      (combinations, name) =>
        combinations.flatMap((carried) =>
          (lookup(CONTENT_PROBE_VALUES, name) ?? []).map((value) => ({
            ...carried,
            [name]: value,
          })),
        ),
      /** @type {Record<string, unknown>[]} */ ([{}]),
    );
    for (const [index, carried] of held.entries())
      carries(
        field,
        carried,
        `with the other fields, combination ${index + 1}`,
      );
  }
}

/**
 * Assert an adapter's {@link import("./control-plane.mjs").Adapter.COVERAGE}
 * hook-coverage matrix is well-formed: it classifies EXACTLY the canonical
 * {@link CALL_CLASSES} (no class missing, none unknown) and every value is a
 * valid coverage status. This is the SSOT gate — adding a new call class to the
 * contract fails every adapter until it declares that class, so a coverage hole
 * can't be introduced by omission.
 * @param {import("./control-plane.mjs").Adapter} adapter
 * @param {any} assert node:assert/strict (injected)
 */
export function assertCoverageWellFormed(adapter, assert) {
  assert.ok(
    adapter.COVERAGE && typeof adapter.COVERAGE === "object",
    `adapter '${adapter.AGENT}' declares no COVERAGE matrix`,
  );
  const declared = Object.keys(adapter.COVERAGE).sort();
  assert.deepEqual(
    declared,
    [...CALL_CLASSES].sort(),
    `adapter '${adapter.AGENT}' COVERAGE must classify exactly the call classes ${JSON.stringify([...CALL_CLASSES])}`,
  );
  for (const cls of CALL_CLASSES) {
    assert.ok(
      isCoverageStatus(adapter.COVERAGE[cls]),
      `adapter '${adapter.AGENT}' COVERAGE.${cls} is not a valid coverage status: ${JSON.stringify(adapter.COVERAGE[cls])}`,
    );
  }
}

/**
 * Assert every tool alias — the global {@link TOOL_ALIASES} entries AND each
 * adapter-scoped alias map — is WITNESSED by a golden fixture: a case whose
 * native tool name equals the alias key and whose normalized `event.tool`
 * equals the canonical target. This is what ties the alias SSOTs to the
 * fixtures: an alias added without a golden payload that exercises it fails
 * here, so an alias "a new judge keys on" can't ship unproven. A global alias
 * may be witnessed by any agent's fixtures; an adapter-scoped alias must be
 * witnessed by THAT agent's fixtures (another agent's payload proves nothing
 * about the scoping adapter's parse). Also cross-checks each witnessed pair:
 * `event.tool` must be either the global {@link canonicalTool} result or the
 * owning adapter's scoped target, so a fixture that preserved `native_tool` but
 * mis-normalized `event.tool` is caught — including a scoped alias applied by
 * the wrong agent's fixtures.
 * @param {any[]} fixturesList the golden fixtures for every shipped adapter
 * @param {any} assert node:assert/strict (injected)
 * @param {Record<string, Record<string, string>>} [adapterAliases] agent id → that adapter's scoped alias map (e.g. `{ gemini: GEMINI_TOOL_ALIASES }`)
 */
export function assertToolAliasesCovered(
  fixturesList,
  assert,
  adapterAliases = {},
) {
  /** @type {Map<string, Map<string, Set<string>>>} agent → native tool name → canonical names seen */
  const witnessedByAgent = new Map();
  for (const fixtures of fixturesList) {
    let witnessed = witnessedByAgent.get(fixtures.agent);
    if (witnessed === undefined)
      witnessedByAgent.set(fixtures.agent, (witnessed = new Map()));
    // `fixtures.agent` and the native tool names below are ADAPTER-SUPPLIED
    // strings; a bare index would resolve `constructor`/`__proto__` to an
    // inherited Object.prototype member instead of missing. See `lookup`.
    const scopedMap = lookup(adapterAliases, fixtures.agent) ?? {};
    for (const testCase of fixtures.cases) {
      const nativeTool = testCase.event?.meta?.native_tool;
      if (typeof nativeTool !== "string") continue;
      const canon = testCase.event.tool;
      const allowed = new Set([canonicalTool(nativeTool)]);
      const scopedTarget = lookup(scopedMap, nativeTool);
      if (scopedTarget !== undefined) allowed.add(scopedTarget);
      assert.ok(
        allowed.has(canon),
        `fixture '${testCase.name}' (${fixtures.agent}): native_tool ${JSON.stringify(nativeTool)} normalized to ${JSON.stringify(canon)}, but only ${JSON.stringify([...allowed])} are valid canonicalizations for this agent`,
      );
      let canons = witnessed.get(nativeTool);
      if (canons === undefined) witnessed.set(nativeTool, (canons = new Set()));
      canons.add(canon);
    }
  }
  /** @type {(nativeName: string, canonical: string) => boolean} */
  const witnessedAnywhere = (nativeName, canonical) =>
    [...witnessedByAgent.values()].some((w) =>
      w.get(nativeName)?.has(canonical),
    );
  for (const [nativeName, canonical] of Object.entries(TOOL_ALIASES)) {
    assert.ok(
      witnessedAnywhere(nativeName, canonical),
      `tool alias ${JSON.stringify(nativeName)} -> ${JSON.stringify(canonical)} is not witnessed by any conformance fixture — add a golden case whose native tool is ${JSON.stringify(nativeName)}`,
    );
  }
  for (const [agent, scopedMap] of Object.entries(adapterAliases)) {
    for (const [nativeName, canonical] of Object.entries(scopedMap)) {
      assert.ok(
        witnessedByAgent.get(agent)?.get(nativeName)?.has(canonical),
        `adapter-scoped tool alias ${JSON.stringify(nativeName)} -> ${JSON.stringify(canonical)} (${agent}) is not witnessed by a '${agent}' conformance fixture — add a golden ${agent} case whose native tool is ${JSON.stringify(nativeName)}`,
      );
    }
  }
}

/**
 * Assert that every case whose tool name was ALIASED carries the canonical
 * tool's input key.
 *
 * Renaming a native tool to a {@link MODELED_TOOLS} name tells every consumer
 * "this is a Read, read it like one" — the README's whole "write your logic
 * once against the normalized types" promise. An adapter that renames the name
 * but forwards the native input dialect makes that promise false in the one
 * direction nobody checks: the judge reads the canonical field, gets
 * `undefined`, and allows. A native-NAMED tool promises nothing and is left
 * alone; this fires only where the adapter itself claimed the schema.
 *
 * The remedy for a failure is a real choice, not a fixture edit: rename the
 * input keys too when the mapping is a pure rename, or drop the alias when it
 * is not (a URL buried in a prose `prompt` cannot be renamed into a `url`
 * without inventing it, and an invented target is worse than a visible gap).
 * @param {any[]} fixturesList the golden fixtures for every shipped adapter
 * @param {any} assert node:assert/strict (injected)
 */
export function assertAliasedInputsCanonical(fixturesList, assert) {
  for (const fixtures of fixturesList)
    for (const testCase of fixtures.cases)
      assertAliasedInput(fixtures.agent, testCase.name, testCase.event, assert);
}

/**
 * The per-event half of {@link assertAliasedInputsCanonical}, shared with
 * {@link runAdapterConformance} so the rule holds against a LIVE parse and not
 * only against the fixture file.
 * @param {string} agent
 * @param {string} caseName
 * @param {any} event a normalized ToolCallEvent
 * @param {any} assert node:assert/strict (injected)
 */
function assertAliasedInput(agent, caseName, event, assert) {
  const nativeTool = event?.meta?.native_tool;
  const canon = event?.tool;
  // Only a RENAME makes the promise; a native-named tool advertises nothing.
  if (typeof nativeTool !== "string" || nativeTool === canon) return;
  const key = lookup(
    /** @type {Record<string, string>} */ (MODELED_TOOL_INPUT_KEYS),
    canon,
  );
  if (key === undefined) return;
  assert.ok(
    event.input !== undefined && Object.hasOwn(event.input, key),
    `'${caseName}' (${agent}): ${JSON.stringify(nativeTool)} was canonicalized to ${JSON.stringify(canon)}, which advertises input.${key}, but the input carries ${JSON.stringify(Object.keys(event.input ?? {}))} — rename the input keys or drop the alias`,
  );
}

/**
 * The control-plane conformance harness.
 *
 * Any adapter — the reference claude one, codex, or a future
 * cursor/cline/gemini-cli/aider translator — must pass this against its own
 * golden fixtures. It pins the two directions of the contract:
 *
 *   1. parse is golden: adapter.parse(native) deep-equals the fixture's
 *      normalized `event` (and never throws — an adapter that threw would fail
 *      here rather than in production).
 *   2. render is golden: for each verdict scenario, adapter.render(verdict,
 *      parsedEvent) deep-equals the fixture's native response. An `allow` with
 *      the unmutated input renders to the agent's native allow; deny/ask/mutation
 *      each render to their native shape.
 *   3. non-vacuity: the fixture set collectively renders an allow, a deny, an
 *      ask, AND a mutated_input, so a suite can't pass while silently skipping a
 *      decision the contract requires every adapter to express.
 *   4. enforcement honesty: an enforceable deny (`rendered.enforced === true`)
 *      MUST carry a real block signal — a non-zero `exit_code` — not just a JSON
 *      body the agent is free to ignore. At least one enforced deny must appear,
 *      so the honesty check is never vacuous.
 *   5. vetoability honesty, BOTH directions. When the parsed event's
 *      `this_call_vetoable` is false, EVERY render for that case must be
 *      `enforced === false` — a guardrail that cannot veto this call must never
 *      render as if it did. And when it is true, a `deny` verdict MUST render
 *      `enforced === true` with a non-zero `exit_code`: where the host can be
 *      stopped, a deny has to stop it. Without the forward half the whole
 *      deny-must-block property rests on each fixture's golden `deepEqual`, so
 *      an adapter that renders a vetoable deny as exit 0 passes as long as its
 *      own fixture was written to match — which is the one bug this harness
 *      exists to make impossible. Item ④'s enforced-deny requirement keeps this
 *      non-vacuous: a suite that never enforces anything fails there.
 *   6. allow = abstain: by default (no `soleGate` opt-in) every `allow` render
 *      is `enforced === false` AND `exit_code === 0` — an "I have no objection"
 *      verdict never renders as a block, on any adapter. At least one `allow`
 *      must be rendered, so this is never vacuous.
 *   7. coverage honesty: the adapter's COVERAGE matrix is well-formed (item ③),
 *      and a fixture case tagged with a `call_class` whose coverage does NOT
 *      permit a veto (uncovered/unknown — an ❓ is treated as ❌) MUST parse to
 *      `this_call_vetoable: false`. An adapter cannot claim a class is un-gated
 *      while parsing its calls as vetoable.
 *   8. unenforceable deny ≠ allow: for every pre-tool fixture event, rendering a
 *      DENY over a non-vetoable variant of that event must produce a response
 *      that differs from the same adapter's abstaining `allow` render. Rule ⑤
 *      only says such a deny is not `enforced`; without this, an adapter is free
 *      to collapse it onto the host's literal "run it" signal (Amp's exit 0),
 *      throwing away the objection entirely. The strongest honest signal a
 *      transport has left — an ask, an advisory body — must survive. An
 *      OBSERVE_ONLY render is exempt: it has no pre-emption channel to differ in.
 *   9. drift honesty: `parse` must ANSWER an event name no host emits with
 *      EventKind.UNKNOWN rather than throw, and a deny rendered on that answer
 *      must not claim a block. Probed on a synthesized payload, since an adapter
 *      whose parse can never emit UNKNOWN has no such fixture to write.
 *  10. content-channel honesty: for every parsed event, each Verdict content
 *      field (mutated_input, mutated_output, additional_context) either reaches
 *      the host's wire or is DECLARED unreachable in the adapter's
 *      UNRENDERED_FIELDS — and the render must agree with the declaration in
 *      both directions. Without it an adapter with no channel for a field just
 *      ignored it, so a redaction verdict rendered a bare allow and the
 *      unredacted output reached the model with nothing saying so. The fields
 *      that DID reach a wire come back as `contentFieldsSeen`; a suite covering
 *      several adapters asserts their union to keep the positive half of the
 *      rule non-vacuous, since no single host has a channel for all three.
 *
 * `assert` is injected (node:assert/strict) so the harness stays test-framework
 * neutral; it throws on the first mismatch. Returns a summary the caller can
 * assert further on.
 *
 * @param {{ adapter: import("./control-plane.mjs").Adapter, fixtures: any, assert: any }} args
 * @returns {{ cases: number, renders: number, decisionsSeen: Set<string>, mutationSeen: boolean, contentFieldsSeen: Set<string>, enforcedDenySeen: boolean, vetoableDenySeen: boolean, unknownKindSeen: boolean, coverageClassesChecked: Set<string>, unenforceableDenyChecks: number }}
 */
export function runAdapterConformance({ adapter, fixtures, assert }) {
  assert.equal(
    adapter.AGENT,
    fixtures.agent,
    `adapter AGENT '${adapter.AGENT}' does not match fixtures.agent '${fixtures.agent}'`,
  );

  assertCoverageWellFormed(adapter, assert);
  assertEveryKindHasARow(adapter, assert);

  /** @type {Set<string>} */
  const decisionsSeen = new Set();
  /** @type {Set<string>} call classes exercised by a tagged fixture case */
  const coverageClassesChecked = new Set();
  let mutationSeen = false;
  /** @type {Set<string>} content fields rule ⑩ saw reach this host's wire */
  const contentFieldsSeen = new Set();
  let enforcedDenySeen = false;
  let vetoableDenySeen = false;
  let unknownKindSeen = false;
  /** @type {Record<string, import("./control-plane.mjs").ToolCallEvent>} */
  const parsedByKind = {};
  let preToolCases = 0;
  let unenforceableDenyChecks = 0;
  let renders = 0;

  for (const testCase of fixtures.cases) {
    const parsed = adapter.parse(testCase.native);
    assert.deepEqual(
      parsed,
      testCase.event,
      `parse mismatch: ${testCase.name}`,
    );
    // Against what parse ACTUALLY produced, not the fixture's copy of it. The
    // deepEqual above ties the two today, but it is the fixture that gets
    // updated when an adapter changes — so checking the fixture alone would let
    // a rename-without-its-input land by editing the expectation.
    assertAliasedInput(adapter.AGENT, testCase.name, parsed, assert);

    // An event the adapter could not name is one whose host response nobody has
    // established, so claiming a veto for it is the one error that lies to a
    // guardrail: the transcript shows a block and the host runs the tool anyway.
    if (parsed.event === EventKind.UNKNOWN) {
      assert.equal(
        parsed.this_call_vetoable,
        false,
        `unmodelled event parsed as vetoable: ${testCase.name}`,
      );
      unknownKindSeen = true;
    }

    if (testCase.call_class !== undefined) {
      assert.ok(
        CALL_CLASSES.includes(testCase.call_class),
        `unknown call_class '${testCase.call_class}': ${testCase.name}`,
      );
      // Fixture-supplied key ⇒ prototype-safe read (see `lookup`): a
      // `call_class` naming an Object.prototype member must MISS, not resolve a
      // function that `coverageAllowsVeto` would then reject or accept by luck.
      const coverage = lookup(adapter.COVERAGE, testCase.call_class);
      if (!coverageAllowsVeto(coverage)) {
        assert.equal(
          parsed.this_call_vetoable,
          false,
          `call_class '${testCase.call_class}' is ${coverage} (no veto) but parsed this_call_vetoable !== false: ${testCase.name}`,
        );
      }
      coverageClassesChecked.add(testCase.call_class);
    }

    for (const [scenario, raw] of Object.entries(testCase.render)) {
      const spec = /** @type {{ verdict: any, native: any }} */ (raw);
      const rendered = adapter.render(spec.verdict, parsed);
      assert.deepEqual(
        rendered,
        spec.native,
        `render mismatch: ${testCase.name} / ${scenario}`,
      );
      if (rendered.enforced) {
        assert.ok(
          rendered.exit_code !== 0,
          `enforced deny carries no block signal: ${testCase.name} / ${scenario}`,
        );
        enforcedDenySeen = true;
      }
      if (parsed.this_call_vetoable === false) {
        assert.equal(
          rendered.enforced,
          false,
          `non-vetoable call rendered as enforced: ${testCase.name} / ${scenario}`,
        );
      }
      // The forward direction, and the one a guardrail's safety rests on: when
      // the host CAN be stopped and the verdict says deny, the render must
      // actually stop it. Without this the direction is left to each fixture's
      // golden `deepEqual`, so an adapter that renders a vetoable deny as exit 0
      // passes as long as its own fixture was written to match.
      if (
        spec.verdict.decision === "deny" &&
        parsed.this_call_vetoable === true
      ) {
        assert.equal(
          rendered.enforced,
          true,
          `vetoable deny did not enforce: ${testCase.name} / ${scenario}`,
        );
        assert.ok(
          rendered.exit_code !== 0,
          `vetoable deny carries no block signal: ${testCase.name} / ${scenario}`,
        );
        vetoableDenySeen = true;
      }
      if (spec.verdict.decision === "allow") {
        assert.equal(
          rendered.enforced,
          false,
          `allow rendered as enforced: ${testCase.name} / ${scenario}`,
        );
        assert.equal(
          rendered.exit_code,
          0,
          `allow rendered a non-zero exit_code: ${testCase.name} / ${scenario}`,
        );
      }
      decisionsSeen.add(spec.verdict.decision);
      if (spec.verdict.mutated_input !== undefined) mutationSeen = true;
      renders += 1;
    }

    parsedByKind[parsed.event] ??= parsed;
    assertContentChannels(
      adapter,
      parsed,
      testCase.name,
      assert,
      contentFieldsSeen,
    );

    // Rule ⑧, probed on a synthesized non-vetoable variant rather than on a
    // fixture flag: an adapter whose COVERAGE marks every reachable call class
    // as gated can never PARSE a non-vetoable event, so a fixture-driven check
    // would sit vacuous on exactly the adapters this rule exists for. Only
    // pre-tool events are probed — a post-tool/prompt event has no veto to lose,
    // so its deny and allow renders may legitimately coincide.
    if (parsed.event !== EventKind.PRE_TOOL) continue;
    preToolCases += 1;
    const unenforceable = { ...parsed, this_call_vetoable: false };
    const deniedRender = adapter.render(
      UNENFORCEABLE_DENY_PROBE,
      unenforceable,
    );
    assert.equal(
      deniedRender.enforced,
      false,
      `unenforceable deny rendered as enforced: ${testCase.name}`,
    );
    // Counted before the OBSERVE_ONLY exemption: the honesty half above ran, so
    // an adapter whose every pre-tool case is observe-only has still been
    // checked and must not fail the non-vacuity assertion below.
    unenforceableDenyChecks += 1;
    // An OBSERVE_ONLY render is exempt from the ≠-allow half: that transport has
    // no pre-emption channel at all, so its deny and allow are identical by
    // construction. Demanding a distinct signal there would demand a fiction.
    if (deniedRender.transport === IntegrationMode.OBSERVE_ONLY) continue;
    assert.notDeepEqual(
      deniedRender,
      adapter.render(ABSTAINING_ALLOW_PROBE, unenforceable),
      `unenforceable deny renders identically to an abstaining allow — the objection is lost: ${testCase.name}`,
    );
  }

  for (const decision of ["allow", "deny", "ask"]) {
    assert.ok(
      decisionsSeen.has(decision),
      `conformance fixtures never render a '${decision}' verdict — the suite is vacuous`,
    );
  }
  assert.ok(
    mutationSeen,
    "conformance fixtures never render a mutated_input verdict — mutation is untested",
  );
  assert.ok(
    enforcedDenySeen,
    "no enforced deny rendered — enforcement honesty is untested",
  );
  // Rule ⑨: parse must ANSWER for an event it cannot name rather than throw, and
  // the render of a deny on that answer must not claim a block. Probed on a
  // synthesized payload rather than a fixture flag, because an adapter whose
  // parse can never emit UNKNOWN — amp routes every payload to pre_tool — has no
  // such fixture to write, and a fixture-driven check would then sit vacuous on
  // exactly the adapters this rule covers.
  const drifted = adapter.parse({ ...DRIFT_PROBE_NATIVE });
  if (drifted.event === EventKind.UNKNOWN) {
    // Not that the event is non-vetoable — `makeEvent` refuses to construct a
    // vetoable UNKNOWN at all, so asserting it here would police a state the
    // constructor already makes unreachable. What only a probe can reach is the
    // RENDER: an adapter is free to derive `enforced` from something other than
    // the flag, and then the false block returns by another door.
    assert.equal(
      adapter.render(UNENFORCEABLE_DENY_PROBE, drifted).enforced,
      false,
      "a deny on an unmodelled event rendered as an enforced block",
    );
    assertContentChannels(
      adapter,
      drifted,
      "rule ⑨ drift probe",
      assert,
      contentFieldsSeen,
    );
    unknownKindSeen = true;
  }
  assert.ok(renders > 0, "conformance fixtures render nothing");
  assert.ok(
    Object.keys(parsedByKind).length > 0,
    "the every-EventKind declaration sweep has no parsed event to build from",
  );
  assertEveryKindRenders(adapter, parsedByKind, assert, contentFieldsSeen);
  // EVERY pre-tool case, not merely one: the count is what catches rule ⑧ being
  // skipped by a stray `continue` rather than merely present somewhere. A suite
  // with no pre-tool case has no veto surface to lose, and rule ⑤'s own
  // `vetoableDenySeen` guard already forces enforcement honesty there.
  assert.equal(
    unenforceableDenyChecks,
    preToolCases,
    `rule ⑧ (unenforceable deny ≠ allow) ran on ${unenforceableDenyChecks} of ${preToolCases} pre-tool cases`,
  );

  return {
    cases: fixtures.cases.length,
    renders,
    decisionsSeen,
    mutationSeen,
    contentFieldsSeen,
    enforcedDenySeen,
    vetoableDenySeen,
    unknownKindSeen,
    coverageClassesChecked,
    unenforceableDenyChecks,
  };
}
