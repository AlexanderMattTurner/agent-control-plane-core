import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAdapterConformance } from "../src/conformance.mjs";

// A framework-neutral echo adapter, independent of the real adapters, so these
// self-tests pin the HARNESS mechanics (does it throw on each way an adapter can
// be wrong) rather than re-testing an adapter. parse echoes the native's
// precomputed `event`; render derives a NativeResponse from the verdict.
const echoAdapter = {
  AGENT: "t",
  INTEGRATION_MODE: "external_hook",
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
