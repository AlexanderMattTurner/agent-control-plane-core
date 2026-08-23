import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runAdapterConformance,
  assertCoverageWellFormed,
  assertToolAliasesCovered,
  assertAliasedInputsCanonical,
} from "../src/conformance.mjs";
import {
  CallClass,
  EventKind,
  coverageAllowsVeto,
  UNRENDERED_ON_UNKNOWN,
  VERDICT_CONTENT_FIELDS,
} from "../src/control-plane.mjs";
import { claudeAdapter } from "../src/adapters/claude.mjs";
import { codexAdapter } from "../src/adapters/codex.mjs";
import { ampAdapter } from "../src/adapters/amp.mjs";
import { geminiAdapter, GEMINI_TOOL_ALIASES } from "../src/adapters/gemini.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (agent) =>
  JSON.parse(
    readFileSync(join(here, "..", "src", "fixtures", `${agent}.json`), "utf8"),
  );

// A framework-neutral echo adapter, independent of the real adapters, so these
// self-tests pin the HARNESS mechanics (does it throw on each way an adapter can
// be wrong) rather than re-testing an adapter. parse echoes the native's
// precomputed `event`; render derives a NativeResponse from the verdict.
const fullCoverage = {
  builtin: "covered",
  mcp: "covered",
  subagent: "covered",
  resumed: "covered",
};

// A minimal event the echo adapter returns verbatim, so a self-test can drive
// this_call_vetoable directly and pin the coverage-matrix checks.
const echoEvent = (vetoable) => ({
  schema_version: 1,
  event: "pre_tool",
  tool: "x",
  input: {},
  this_call_vetoable: vetoable,
  meta: {},
});

// The echo transport is exit-code only, like Amp's: no stdout body, so no
// content field can reach the wire. Declaring that is what rule ⑩ asks of a real
// adapter, and it keeps the self-tests below testing the rule they name.
const echoUnrendered = Object.fromEntries(
  ["pre_tool", "post_tool", "prompt_submit", "session_start", "unknown"].map(
    (kind) => [kind, new Set(VERDICT_CONTENT_FIELDS)],
  ),
);

const echoAdapter = {
  AGENT: "t",
  INTEGRATION_MODE: "external_hook",
  COVERAGE: fullCoverage,
  UNRENDERED_FIELDS: echoUnrendered,
  // A payload the fixtures did not precompute is the DRIFT case rule ⑨ probes:
  // the adapter contract is that parse answers an unmodelled event with an
  // UNKNOWN kind rather than throwing.
  parse: (native) => native.event ?? { ...echoEvent(false), event: "unknown" },
  // Honours `this_call_vetoable` the way rule ⑤/⑧ require of a REAL adapter: a
  // deny it cannot enforce degrades to the transport's ask (1), never to allow.
  render: (verdict, event) => {
    const enforced =
      verdict.decision === "deny" && event.this_call_vetoable === true;
    return {
      transport: "external_hook",
      exit_code: enforced ? 2 : verdict.decision === "deny" ? 1 : 0,
      enforced,
    };
  },
};

const deny = (exit_code, enforced) => ({
  transport: "external_hook",
  exit_code,
  enforced,
});

function fullFixtures() {
  return {
    agent: "t",
    cases: [
      {
        name: "c",
        native: { event: echoEvent(true) },
        event: echoEvent(true),
        render: {
          allow: { verdict: { decision: "allow" }, native: deny(0, false) },
          deny: { verdict: { decision: "deny" }, native: deny(2, true) },
          ask: { verdict: { decision: "ask" }, native: deny(0, false) },
          mutation: {
            verdict: { decision: "allow", mutated_input: { a: 1 } },
            native: deny(0, false),
          },
        },
      },
    ],
  };
}

const run = (adapter, fixtures) =>
  runAdapterConformance({ adapter, fixtures, assert });

const observeOnlyNative = {
  transport: "observe_only",
  exit_code: 0,
  enforced: false,
};

// An adapter that can only watch: it renders every verdict identically because
// its transport has no pre-emption channel at all.
const observerAdapter = { ...echoAdapter, render: () => observeOnlyNative };

// The matching fixtures. The event is NON-vetoable, which is what an
// observe-only transport actually reports: rule ⑤ ("a vetoable deny must
// enforce") then has nothing to say, so these cases reach the enforcement-
// honesty guard they exist to probe rather than tripping an earlier rule.
function observeOnlyFixtures() {
  const fx = fullFixtures();
  fx.cases[0].native = { event: echoEvent(false) };
  fx.cases[0].event = echoEvent(false);
  for (const key of ["allow", "deny", "ask", "mutation"])
    fx.cases[0].render[key].native = observeOnlyNative;
  return fx;
}

describe("conformance harness self-tests (drift honesty, item ⑨)", () => {
  it("refuses an adapter that marks an unmodelled event vetoable", () => {
    // The failure this rule exists for: a kind the adapter could not name is one
    // whose host response nobody established, so an enforced block reported for
    // it tells a guardrail the call stopped while the host ran the tool.
    const driftingAdapter = {
      ...echoAdapter,
      parse: (native) =>
        native.event ?? { ...echoEvent(true), event: "unknown" },
    };
    // The echo adapter builds its events by hand rather than through makeEvent,
    // which is what lets this case exist at all — and it is the shape rule ⑨ is
    // for, since an adapter deriving `enforced` its own way reaches the wire
    // without the constructor ever seeing the flag.
    assert.throws(
      () => run(driftingAdapter, fullFixtures()),
      /rendered as an enforced block/,
    );
  });

  it("reports the probe ran, so the rule cannot pass by never firing", () => {
    assert.equal(run(echoAdapter, fullFixtures()).unknownKindSeen, true);
  });
});

describe("conformance harness self-tests (non-vacuity)", () => {
  it("passes a correct adapter and reports the summary", () => {
    const summary = run(echoAdapter, fullFixtures());
    assert.equal(summary.cases, 1);
    assert.equal(summary.renders, 4);
    assert.equal(summary.mutationSeen, true);
    assert.equal(summary.enforcedDenySeen, true);
    assert.deepEqual(
      [...summary.decisionsSeen].sort(),
      ["allow", "ask", "deny"].sort(),
    );
  });

  it("throws when the adapter AGENT disagrees with the fixtures", () => {
    assert.throws(
      () => run({ ...echoAdapter, AGENT: "other" }, fullFixtures()),
      /does not match fixtures\.agent/,
    );
  });

  it("throws when parse output diverges from the golden event", () => {
    const bad = { ...echoAdapter, parse: () => ({ k: 999 }) };
    assert.throws(() => run(bad, fullFixtures()), /parse mismatch/);
  });

  it("throws when render output diverges from the golden native", () => {
    const bad = { ...echoAdapter, render: () => deny(0, false) };
    assert.throws(() => run(bad, fullFixtures()), /render mismatch/);
  });

  it("throws when the fixtures never render a required decision", () => {
    const fx = fullFixtures();
    delete fx.cases[0].render.ask;
    assert.throws(() => run(echoAdapter, fx), /never render a 'ask'/);
  });

  it("throws when the fixtures never render a mutation", () => {
    const fx = fullFixtures();
    delete fx.cases[0].render.mutation;
    assert.throws(() => run(echoAdapter, fx), /mutation is untested/);
  });

  it("throws when an enforced deny carries no block signal", () => {
    const bad = {
      ...echoAdapter,
      render: (v) => ({
        transport: "external_hook",
        exit_code: 0,
        enforced: v.decision === "deny",
      }),
    };
    const fx = fullFixtures();
    fx.cases[0].render.deny.native = deny(0, true);
    assert.throws(() => run(bad, fx), /carries no block signal/);
  });

  it("throws when an unenforceable deny renders as the host's allow (rule ⑧)", () => {
    // The Amp regression in adapter form: a render that ignores this_call_vetoable
    // for the exit code, so a deny it cannot enforce is byte-identical to allow.
    const collapsing = {
      ...echoAdapter,
      render: (verdict, event) => {
        const enforced =
          verdict.decision === "deny" && event.this_call_vetoable === true;
        return {
          transport: "external_hook",
          exit_code: enforced ? 2 : 0,
          enforced,
        };
      },
    };
    assert.throws(
      () => run(collapsing, fullFixtures()),
      /unenforceable deny renders identically to an abstaining allow/,
    );
  });

  it("exempts an OBSERVE_ONLY render, which has no channel to differ in", () => {
    // Same collapsing render as the case above, but on a transport that cannot
    // pre-empt at all — there the identical rendering is the truth, not a lost
    // objection. Asserted on WHICH guard fires: rule ⑧ must stay silent, and the
    // run must fall through to the later enforcement-honesty guard.
    let err = null;
    try {
      run(observerAdapter, observeOnlyFixtures());
    } catch (caught) {
      err = caught;
    }
    assert.ok(err, "the observe-only suite passed conformance outright");
    assert.doesNotMatch(
      String(err),
      /identically to an abstaining allow/,
      "rule ⑧ fired on an observe-only render it must exempt",
    );
    assert.match(String(err), /enforcement honesty is untested/);
  });

  it("a declared row cannot be mutated out from under the contract", () => {
    // Object.freeze does not freeze a Set's CONTENTS, and these rows are shared
    // between adapters — so one `delete` would make several declarations report
    // a channel their renders still discard.
    for (const row of [
      UNRENDERED_ON_UNKNOWN,
      claudeAdapter.UNRENDERED_FIELDS.pre_tool,
    ]) {
      assert.throws(() => row.delete("mutated_output"));
      assert.throws(() => row.add("bogus"));
    }
    // The callback's third argument is the SET, so forwarding to the private
    // one would hand a consumer the mutable original through the read half.
    UNRENDERED_ON_UNKNOWN.forEach((value, key, set) => {
      assert.equal(value, key);
      assert.throws(() => set.delete(value));
      assert.throws(() => set.clear());
    });
    assert.equal(UNRENDERED_ON_UNKNOWN.has("mutated_output"), true);
    assert.equal(UNRENDERED_ON_UNKNOWN.size, 3);
  });

  it("names the missing member when an adapter declares no UNRENDERED_FIELDS", () => {
    // An adapter written against the earlier contract: the map is absent
    // entirely, and reading a row off it throws a bare TypeError from inside
    // the harness. The author reading that is a third-party adapter's, so the
    // failure has to name the member and how to add it.
    const { UNRENDERED_FIELDS, ...legacy } = echoAdapter;
    void UNRENDERED_FIELDS;
    assert.throws(
      () => run(/** @type {any} */ (legacy), fullFixtures()),
      /declares no UNRENDERED_FIELDS .* one row per EventKind/s,
    );
  });

  it("throws when an UNRENDERED_FIELDS row is not a ReadonlySet", () => {
    // `null` answers nothing at every `has`, so the adapter claims every
    // channel; a has-only stand-in passes that check and then fails the first
    // consumer that iterates the row or reads its size.
    for (const row of [
      null,
      { has: () => true },
      // Every member a Set has, and `[key, value]` pairs for a consumer that
      // iterates it.
      new Map([["mutated_output", true]]),
      // A field name no Verdict carries: a typo that reads as a declaration.
      new Set(["mutatedOutput"]),
      // Every reader present and callable, and one of them throws.
      Object.assign(new Set(["mutated_output"]), {
        forEach: () => {
          throw new Error("row reader is broken");
        },
      }),
      // Iterates one field while `has` says yes to all three: rule ⑩ reads one
      // declaration and a consumer that iterates the row reads another.
      Object.assign(new Set(["mutated_output"]), { has: () => true }),
      // Correct values, and a third argument that is not the row — a handle the
      // frozen facade exists to withhold.
      Object.assign(new Set(["mutated_output"]), {
        forEach: (/** @type {any} */ fn) =>
          fn("mutated_output", "mutated_output", null),
      }),
    ]) {
      const broken = { ...echoUnrendered, [EventKind.POST_TOOL]: row };
      assert.throws(
        () =>
          run({ ...echoAdapter, UNRENDERED_FIELDS: broken }, fullFixtures()),
        /row for 'post_tool'|row reader is broken/,
      );
    }
  });

  it("throws when UNRENDERED_FIELDS has no row for a rendered kind", () => {
    // Read as "every field reaches a channel", a missing row tells a consumer
    // the opposite of the truth on a transport that carries none.
    const { pre_tool, ...missingRow } = echoUnrendered;
    void pre_tool;
    assert.throws(
      () =>
        run({ ...echoAdapter, UNRENDERED_FIELDS: missingRow }, fullFixtures()),
      /has no row for 'pre_tool'/,
    );
    // The kind NO fixture produces is the one whose row goes missing, so the
    // check reads the EventKind SSOT rather than the events it happens to see.
    const { session_start, ...noSessionRow } = echoUnrendered;
    void session_start;
    assert.throws(
      () =>
        run(
          { ...echoAdapter, UNRENDERED_FIELDS: noSessionRow },
          fullFixtures(),
        ),
      /has no row for 'session_start'/,
    );
  });

  it("builds a coherent event for a kind no fixture produces", () => {
    // Re-labelling a pre_tool event leaves a `tool` the contract says is null
    // on a prompt/session kind, and a `native_event` naming the wrong host
    // event — an adapter picking its schema from either is probed about a
    // channel that is not the one under test. The marker name is what an
    // adapter sees instead: `parse` always stamps this field, so leaving it
    // absent sends a renderer down a fallback no real event reaches.
    const seen = [];
    const recording = {
      ...echoAdapter,
      render: (verdict, event) => {
        seen.push(event);
        return echoAdapter.render(verdict, event);
      },
    };
    // The seed carries `native_tool`, so the assertion below is about a field
    // that was really there — without it the probe would pass on a seed that
    // never had one. Stamped on both sides of the fixture, since rule ① compares
    // `parse` against the golden event.
    const fixtures = fullFixtures();
    for (const testCase of fixtures.cases) {
      testCase.native.event.meta.native_tool = "Bash";
      testCase.event.meta.native_tool = "Bash";
    }
    run(recording, fixtures);
    const seeded = seen.filter((e) => e.event === "pre_tool");
    assert.ok(seeded.length > 0);
    for (const event of seeded) assert.equal(event.meta?.native_tool, "Bash");
    const probes = seen.filter((e) => e.event === "prompt_submit");
    assert.ok(probes.length > 0);
    for (const event of probes) {
      assert.equal(event.tool, null);
      assert.equal(
        event.meta?.native_event,
        "acpc-conformance-synthesized-event",
      );
      assert.equal("response" in event, false);
      assert.equal("native_tool" in (event.meta ?? {}), false);
    }
    // `makeEvent` refuses a vetoable UNKNOWN, and the seed here IS vetoable, so
    // spreading it whole would build the state the contract rejects.
    // Nothing here says the adapter gates a kind no fixture produced, and
    // `makeEvent` refuses a vetoable UNKNOWN outright. The seed IS vetoable, so
    // spreading it whole would claim a block the host never performs.
    const synthesized = seen.filter((e) => e.event !== "pre_tool");
    assert.ok(synthesized.length > 0);
    for (const event of synthesized)
      assert.equal(event.this_call_vetoable, false);
  });

  it("probes with the adapter's own native event when it names one", () => {
    // The marker is the fallback, not the answer: an adapter that says which
    // native event a kind uses gets probed on the branch that kind really
    // takes, rather than on its unrecognized-event branch.
    const seen = [];
    const naming = {
      ...echoAdapter,
      NATIVE_EVENT_FOR: { [EventKind.PROMPT_SUBMIT]: "UserPromptSubmit" },
      render: (verdict, event) => {
        seen.push(event);
        return echoAdapter.render(verdict, event);
      },
    };
    run(naming, fullFixtures());
    const probed = seen.filter((e) => e.event === EventKind.PROMPT_SUBMIT);
    assert.ok(probed.length > 0);
    for (const event of probed)
      assert.equal(event.meta?.native_event, "UserPromptSubmit");
  });

  it("probes a declared row for a kind no fixture produces", () => {
    // Row existence is not agreement: a row for an unreached kind could claim a
    // channel the render drops, and the per-fixture probes would never ask.
    const lying = {
      ...echoAdapter,
      UNRENDERED_FIELDS: {
        ...echoUnrendered,
        session_start: new Set(["mutated_output", "additional_context"]),
      },
    };
    assert.throws(
      () => run(lying, fullFixtures()),
      /mutated_input reaches no native channel on session_start/,
    );
  });

  it("throws when a content field reaches no channel and is not declared", () => {
    // The gap rule ⑩ exists for: an adapter with no channel for a field just
    // ignored it, so a redaction verdict rendered a bare allow and the
    // unredacted output reached the model with nothing saying so.
    const undeclared = {
      ...echoAdapter,
      UNRENDERED_FIELDS: {
        ...echoUnrendered,
        pre_tool: new Set(["mutated_output", "additional_context"]),
      },
    };
    assert.throws(
      () => run(undeclared, fullFixtures()),
      /mutated_input reaches no native channel on pre_tool and is not declared/,
    );
  });

  it("throws when a DECLARED-unrendered field still reaches the wire", () => {
    // The other direction, and the one that goes stale silently: the comment and
    // the declaration say "dropped" while the channel is live, so a reviewer
    // reading the declaration is told the opposite of what ships.
    const leaking = {
      ...echoAdapter,
      render: (verdict, event) => {
        const rendered = echoAdapter.render(verdict, event);
        // Only when the field is present, so the fixtures' own goldens (which
        // carry no additional_context) still match and rule ② stays silent —
        // this test must fail on rule ⑩ or not at all.
        if (verdict.additional_context === undefined) return rendered;
        return { ...rendered, stdout: { context: verdict.additional_context } };
      },
    };
    assert.throws(
      () => run(leaking, fullFixtures()),
      /declares additional_context has no channel on pre_tool, but the render carries its value/,
    );
  });

  it("throws when no enforced deny is rendered at all", () => {
    assert.throws(
      () => run(observerAdapter, observeOnlyFixtures()),
      /enforcement honesty is untested/,
    );
  });
});

// A fixture pairing the standard all-verdicts case (satisfies the non-vacuity +
// enforcement-honesty guards) with a second case tagged `call_class`, whose only
// render is an advisory allow — so the coverage tie-in is what's under test, not
// the other rules. A non-vetoable tagged case correctly renders no enforced deny.
function coverageFixture({ call_class, vetoable = true }) {
  const tagged = {
    name: "cov-tagged",
    native: { event: echoEvent(vetoable) },
    event: echoEvent(vetoable),
    render: {
      allow: { verdict: { decision: "allow" }, native: deny(0, false) },
    },
  };
  if (call_class !== undefined) tagged.call_class = call_class;
  return { agent: "t", cases: [fullFixtures().cases[0], tagged] };
}

describe("conformance harness self-tests (coverage matrix, item ③)", () => {
  it("assertCoverageWellFormed accepts a complete, valid matrix", () => {
    assert.doesNotThrow(() =>
      assertCoverageWellFormed({ AGENT: "t", COVERAGE: fullCoverage }, assert),
    );
  });

  it("throws when the adapter declares no COVERAGE matrix", () => {
    const { COVERAGE, ...noCoverage } = echoAdapter;
    void COVERAGE;
    assert.throws(
      () => run(noCoverage, fullFixtures()),
      /declares no COVERAGE matrix/,
    );
  });

  it("throws when COVERAGE omits a call class", () => {
    const { mcp, ...missing } = fullCoverage;
    void mcp;
    assert.throws(
      () => run({ ...echoAdapter, COVERAGE: missing }, fullFixtures()),
      /must classify exactly the call classes/,
    );
  });

  it("throws when COVERAGE declares an unknown call class", () => {
    assert.throws(
      () =>
        run(
          { ...echoAdapter, COVERAGE: { ...fullCoverage, bogus: "covered" } },
          fullFixtures(),
        ),
      /must classify exactly the call classes/,
    );
  });

  it("throws when a coverage status is invalid", () => {
    assert.throws(
      () =>
        run(
          { ...echoAdapter, COVERAGE: { ...fullCoverage, mcp: "maybe" } },
          fullFixtures(),
        ),
      /is not a valid coverage status/,
    );
  });

  it("throws when a case tagged with an unknown call_class name", () => {
    assert.throws(
      () => run(echoAdapter, coverageFixture({ call_class: "wat" })),
      /unknown call_class 'wat'/,
    );
  });

  it("throws when an uncovered class parses as vetoable (❓/❌ must be false)", () => {
    const adapter = {
      ...echoAdapter,
      COVERAGE: { ...fullCoverage, mcp: "uncovered" },
    };
    assert.throws(
      () =>
        run(adapter, coverageFixture({ call_class: "mcp", vetoable: true })),
      /is uncovered \(no veto\) but parsed this_call_vetoable !== false/,
    );
  });

  it("throws identically when an UNKNOWN class parses as vetoable", () => {
    const adapter = {
      ...echoAdapter,
      COVERAGE: { ...fullCoverage, mcp: "unknown" },
    };
    assert.throws(
      () =>
        run(adapter, coverageFixture({ call_class: "mcp", vetoable: true })),
      /is unknown \(no veto\) but parsed this_call_vetoable !== false/,
    );
  });

  it("passes when an uncovered class parses non-vetoable, and records the class", () => {
    const adapter = {
      ...echoAdapter,
      COVERAGE: { ...fullCoverage, mcp: "uncovered" },
    };
    const summary = run(
      adapter,
      coverageFixture({ call_class: "mcp", vetoable: false }),
    );
    assert.deepEqual([...summary.coverageClassesChecked], ["mcp"]);
  });

  it("permits a covered/partial class to be vetoable", () => {
    for (const status of ["covered", "partial"]) {
      const adapter = {
        ...echoAdapter,
        COVERAGE: { ...fullCoverage, mcp: status },
      };
      assert.doesNotThrow(() =>
        run(adapter, coverageFixture({ call_class: "mcp", vetoable: true })),
      );
    }
  });
});

describe("conformance harness self-tests (deny must block, item \u2464)", () => {
  // A vetoable call whose deny renders exit 0 is a deny that does not deny. The
  // golden `deepEqual` cannot catch it: the fixture below is written to match
  // the broken render exactly, which is how such an adapter would ship green.
  function vetoableDenyFixtures(nativeDeny) {
    return {
      agent: "t",
      cases: [
        {
          name: "vetoable",
          // post_tool, not pre_tool: a vetoable deny must block on either, and
          // this suite isolates rule ⑤ from rule ⑧'s pre-tool-only probe.
          native: {
            event: { event: "post_tool", k: 1, this_call_vetoable: true },
          },
          event: { event: "post_tool", k: 1, this_call_vetoable: true },
          render: {
            allow: { verdict: { decision: "allow" }, native: deny(0, false) },
            deny: { verdict: { decision: "deny" }, native: nativeDeny },
            ask: { verdict: { decision: "ask" }, native: deny(0, false) },
            mutation: {
              verdict: { decision: "allow", mutated_input: { a: 1 } },
              native: deny(0, false),
            },
          },
        },
      ],
    };
  }

  const silentlyAllowing = {
    ...echoAdapter,
    render: () => deny(0, false),
  };

  it("throws when a vetoable deny renders as a non-block", () => {
    assert.throws(
      () => run(silentlyAllowing, vetoableDenyFixtures(deny(0, false))),
      /vetoable deny did not enforce/,
    );
  });

  it("throws when a vetoable deny claims enforced but exits 0", () => {
    const claimsWithoutBlocking = {
      ...echoAdapter,
      render: (verdict) => deny(0, verdict.decision === "deny"),
    };
    assert.throws(
      () => run(claimsWithoutBlocking, vetoableDenyFixtures(deny(0, true))),
      /enforced deny carries no block signal/,
    );
  });

  it("passes an adapter whose vetoable deny really blocks", () => {
    const summary = run(echoAdapter, vetoableDenyFixtures(deny(2, true)));
    // Positive marker: the forward check actually ran on this suite.
    assert.equal(summary.vetoableDenySeen, true);
  });
});

describe("assertToolAliasesCovered ties the alias SSOTs to fixtures", () => {
  const allFixtures = ["claude", "codex", "amp", "gemini"].map(loadFixture);
  const shippedScoped = { gemini: GEMINI_TOOL_ALIASES };

  it("every aliased case carries the canonical tool's input key", () => {
    // The bypass this closes: renaming `read_file` to `Read` tells a judge to
    // read `input.file_path`, and a forwarded `absolute_path` makes that read
    // `undefined` — so the judge allows, believing it inspected a Read.
    assert.doesNotThrow(() =>
      assertAliasedInputsCanonical(allFixtures, assert),
    );
  });

  it("passes: the shipped fixtures witness every global and adapter-scoped alias", () => {
    assert.doesNotThrow(() =>
      assertToolAliasesCovered(allFixtures, assert, shippedScoped),
    );
  });

  it("throws when no fixture witnesses a global alias (drop gemini's run_shell_command)", () => {
    // Only gemini's fixtures carry run_shell_command → Bash; without them the
    // alias in TOOL_ALIASES is unproven and the check must fail.
    const withoutGemini = allFixtures.filter((f) => f.agent !== "gemini");
    assert.throws(
      () => assertToolAliasesCovered(withoutGemini, assert),
      /tool alias "run_shell_command" -> "Bash" is not witnessed/,
    );
  });

  it("throws when an adapter-scoped alias has no fixture witness", () => {
    assert.throws(
      () =>
        assertToolAliasesCovered(allFixtures, assert, {
          gemini: { ...GEMINI_TOOL_ALIASES, save_memory: "Write" },
        }),
      /adapter-scoped tool alias "save_memory" -> "Write" \(gemini\) is not witnessed by a 'gemini' conformance fixture/,
    );
  });

  it("scoped witnesses are agent-scoped: another agent's fixture proves nothing", () => {
    const geminiWithoutReadFile = allFixtures.map((f) =>
      f.agent === "gemini"
        ? {
            ...f,
            cases: f.cases.filter(
              (c) => c.event?.meta?.native_tool !== "read_file",
            ),
          }
        : f,
    );
    // A claude case legitimately passing read_file through verbatim does NOT
    // witness the gemini-scoped read_file → Read alias.
    const passthroughWitness = {
      agent: "claude",
      cases: [
        {
          name: "claude read_file passthrough",
          event: { tool: "read_file", meta: { native_tool: "read_file" } },
        },
      ],
    };
    assert.throws(
      () =>
        assertToolAliasesCovered(
          [...geminiWithoutReadFile, passthroughWitness],
          assert,
          shippedScoped,
        ),
      /adapter-scoped tool alias "read_file" -> "Read" \(gemini\) is not witnessed/,
    );
    // And a claude case that APPLIED the gemini-only alias is rejected outright:
    // the scoped map is not a valid canonicalization for another agent.
    const misScoped = {
      agent: "claude",
      cases: [
        {
          name: "claude applies gemini alias",
          event: { tool: "Read", meta: { native_tool: "read_file" } },
        },
      ],
    };
    assert.throws(
      () => assertToolAliasesCovered([misScoped], assert, shippedScoped),
      /only \["read_file"\] are valid canonicalizations/,
    );
  });

  it("a matching witness under ANOTHER adapter's identical scoped alias does not count", () => {
    // 'other' legitimately witnesses read_file → Read under its OWN scoped
    // alias; gemini's copy of the alias must still demand a gemini witness.
    const geminiWithoutReadFile = allFixtures.map((f) =>
      f.agent === "gemini"
        ? {
            ...f,
            cases: f.cases.filter(
              (c) => c.event?.meta?.native_tool !== "read_file",
            ),
          }
        : f,
    );
    const otherWitness = {
      agent: "other",
      cases: [
        {
          name: "other read_file",
          event: { tool: "Read", meta: { native_tool: "read_file" } },
        },
      ],
    };
    assert.throws(
      () =>
        assertToolAliasesCovered(
          [...geminiWithoutReadFile, otherWitness],
          assert,
          { gemini: GEMINI_TOOL_ALIASES, other: { read_file: "Read" } },
        ),
      /adapter-scoped tool alias "read_file" -> "Read" \(gemini\) is not witnessed/,
    );
  });

  it("a prototype-named agent id MISSES the scoped-alias map, never inherits", () => {
    // `adapterAliases[fixtures.agent]` with agent "constructor" used to resolve
    // Object itself, whose `name` property then read back as the string "Object"
    // — silently blessing `native_tool: "name"` → `tool: "Object"` as a valid
    // canonicalization. Routed through `lookup`, it is a miss, so the only valid
    // canonicalization is the verbatim native name and the fixture is rejected.
    const inheritedHit = {
      agent: "constructor",
      cases: [
        {
          name: "prototype-keyed agent",
          event: { tool: "Object", meta: { native_tool: "name" } },
        },
      ],
    };
    assert.throws(
      () => assertToolAliasesCovered([inheritedHit], assert, {}),
      /only \["name"\] are valid canonicalizations/,
    );
  });

  it("a prototype-named native tool MISSES a real scoped-alias map", () => {
    // Same defect one level down: `scopedMap["toString"]` inherits a function.
    // With `lookup` the only valid canonicalization is the verbatim name, so a
    // fixture claiming any other target is rejected rather than compared against
    // an inherited Function.
    const scoped = { x: { run_shell_command: "Bash" } };
    const inheritedHit = {
      agent: "x",
      cases: [
        {
          name: "prototype-keyed native tool",
          event: { tool: "Bash", meta: { native_tool: "toString" } },
        },
      ],
    };
    assert.throws(
      () => assertToolAliasesCovered([inheritedHit], assert, scoped),
      /only \["toString"\] are valid canonicalizations/,
    );
  });

  it("throws when a fixture preserves native_tool but mis-normalizes event.tool", () => {
    const bad = {
      agent: "x",
      cases: [
        {
          name: "mis-normalized",
          event: {
            tool: "NotBash",
            meta: { native_tool: "run_shell_command" },
          },
        },
      ],
    };
    assert.throws(
      () => assertToolAliasesCovered([bad], assert),
      /only \["Bash"\] are valid canonicalizations/,
    );
  });

  it("ignores cases without a native_tool (non-tool events)", () => {
    const promptOnly = {
      agent: "x",
      cases: [{ name: "prompt", event: { tool: null, meta: {} } }],
    };
    // No aliases witnessed → the run_shell_command alias is unproven → throws,
    // but the point is the native_tool-less case is simply skipped (no crash on
    // a missing meta.native_tool), which the throw path here exercises.
    assert.throws(
      () => assertToolAliasesCovered([promptOnly], assert),
      /is not witnessed/,
    );
  });

  it("skips a native_tool-less case yet still passes when the aliases ARE witnessed", () => {
    // POSITIVE proof the skip path is taken: pair a native_tool-less case (which
    // the throw test above can only show is ignored via an unrelated throw) WITH
    // a real witness for the sole global alias (run_shell_command → Bash). If the
    // skip mis-fired — e.g. crashing on the missing meta.native_tool, or letting
    // the prompt case poison the witness set — this doesNotThrow would fail.
    const witnessed = {
      agent: "x",
      cases: [
        { name: "prompt", event: { tool: null, meta: {} } },
        {
          name: "shell witness",
          event: { tool: "Bash", meta: { native_tool: "run_shell_command" } },
        },
      ],
    };
    assert.doesNotThrow(() => assertToolAliasesCovered([witnessed], assert));
  });
});

describe("coverage-witness: an mcp class marked un-vetoable is proven by a fixture", () => {
  // runAdapterConformance already enforces that IF an mcp-tagged fixture exists it
  // parses this_call_vetoable=false (item ⑦ coverage honesty). What that leaves
  // unchecked is EXISTENCE: an adapter can declare mcp uncovered/unknown and ship
  // zero mcp fixtures, so the un-gated claim is never exercised. Assert the
  // witnessable subset — every shipped adapter whose mcp coverage forbids a veto
  // must have an mcp-tagged fixture (surfaced via coverageClassesChecked), which
  // running conformance also proves parses non-vetoable.
  //
  // subagent/resumed are deliberately EXEMPT: classifyCallClass can only ever
  // return BUILTIN or MCP from a lone payload — subagent/resumed have no
  // detectable signal — so no real fixture can witness them and a blanket
  // "every un-vetoable class is witnessed" assertion is unsatisfiable by design.
  const shipped = [claudeAdapter, codexAdapter, ampAdapter, geminiAdapter];
  for (const adapter of shipped) {
    it(`${adapter.AGENT}: mcp coverage forbidding veto is witnessed by an mcp fixture`, () => {
      const fixtures = loadFixture(adapter.AGENT);
      const summary = runAdapterConformance({ adapter, fixtures, assert });
      if (!coverageAllowsVeto(adapter.COVERAGE[CallClass.MCP]))
        assert.ok(
          summary.coverageClassesChecked.has(CallClass.MCP),
          `${adapter.AGENT} marks mcp ${adapter.COVERAGE[CallClass.MCP]} (no veto) but ships no mcp-tagged fixture to witness the un-gated class`,
        );
    });
  }
});

describe("rule ⑩ non-vacuity: every content field is witnessed on some adapter", () => {
  // Per-adapter the rule cannot demand all three — Codex documents exactly one
  // content channel, and Amp none at all — so a shipped adapter that renders a
  // field is the only thing that proves the POSITIVE half of rule ⑩ ever fires.
  // Without this the whole rule could pass with every adapter declaring every
  // field dropped, which is the vacuous suite it exists to prevent.
  it("the four shipped adapters together render every Verdict content field", () => {
    const seen = new Set();
    for (const adapter of [
      claudeAdapter,
      codexAdapter,
      ampAdapter,
      geminiAdapter,
    ])
      for (const field of runAdapterConformance({
        adapter,
        fixtures: loadFixture(adapter.AGENT),
        assert,
      }).contentFieldsSeen)
        seen.add(field);
    assert.deepEqual([...seen].sort(), [...VERDICT_CONTENT_FIELDS].sort());
  });
});
