import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runAdapterConformance,
  assertCoverageWellFormed,
} from "../src/conformance.mjs";

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

const echoAdapter = {
  AGENT: "t",
  INTEGRATION_MODE: "external_hook",
  COVERAGE: fullCoverage,
  parse: (native) => native.event,
  render: (verdict) => ({
    transport: "external_hook",
    exit_code: verdict.decision === "deny" ? 2 : 0,
    enforced: verdict.decision === "deny",
  }),
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
        native: { event: { k: 1 } },
        event: { k: 1 },
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

  it("throws when no enforced deny is rendered at all", () => {
    const advisory = {
      ...echoAdapter,
      render: () => ({
        transport: "observe_only",
        exit_code: 0,
        enforced: false,
      }),
    };
    const fx = fullFixtures();
    for (const key of ["allow", "deny", "ask", "mutation"])
      fx.cases[0].render[key].native = {
        transport: "observe_only",
        exit_code: 0,
        enforced: false,
      };
    assert.throws(() => run(advisory, fx), /enforcement honesty is untested/);
  });
});

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
