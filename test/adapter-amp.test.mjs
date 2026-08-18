import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ampAdapter, render } from "../src/adapters/amp.mjs";
import { runAdapterConformance } from "../src/conformance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, "..", "src", "fixtures", "amp.json"), "utf8"),
);

// Amp's transport is pure exit codes (no stdout body): allow 0 / ask 1 / reject 2.
// A green run proves the normalized shape is identical to Claude's while the
// transport is entirely different.
describe("amp adapter conformance", () => {
  it("parse/render are golden; deny renders exit 2 with no stdout", () => {
    const summary = runAdapterConformance({
      adapter: ampAdapter,
      fixtures,
      assert,
    });
    assert.ok(summary.cases >= 2);
    assert.ok(
      summary.unenforceableDenyChecks > 0,
      "rule ⑧ (unenforceable deny ≠ allow) never ran on the amp fixtures",
    );
    assert.equal(summary.mutationSeen, true);
    assert.equal(summary.enforcedDenySeen, true);
    for (const decision of ["allow", "deny", "ask"])
      assert.ok(summary.decisionsSeen.has(decision));
  });

  it("declares AGENT and external_hook integration", () => {
    assert.equal(ampAdapter.AGENT, "amp");
    assert.equal(ampAdapter.INTEGRATION_MODE, "external_hook");
  });
});

// The vetoable dimension. Amp's COVERAGE marks every call class `classifyCallClass`
// can actually return (BUILTIN/MCP) as COVERED, so no golden fixture payload can
// PARSE to `this_call_vetoable: false` — the events below are built directly, which
// is also how a host whose coverage later degrades would reach this render.
describe("amp render: the full (decision × this_call_vetoable) table", () => {
  const eventFor = (this_call_vetoable) => ({
    ...ampAdapter.parse({ tool: "Bash", input: { command: "ls" } }),
    this_call_vetoable,
  });

  const cases = [
    // decision, vetoable, exit_code, enforced
    ["allow", true, 0, false],
    ["allow", false, 0, false],
    ["deny", true, 2, true],
    // The regression this table exists for: an unenforceable deny used to fall
    // through the ternary chain to exit 0 — Amp's "run it".
    ["deny", false, 1, false],
    ["ask", true, 1, false],
    ["ask", false, 1, false],
  ];

  for (const [decision, vetoable, exit_code, enforced] of cases) {
    it(`${decision} on a ${vetoable ? "vetoable" : "non-vetoable"} call → exit ${exit_code}`, () => {
      assert.deepEqual(render({ decision, reason: "r" }, eventFor(vetoable)), {
        transport: "external_hook",
        exit_code,
        enforced,
      });
    });
  }

  it("an unenforceable deny is never Amp's allow signal", () => {
    const event = eventFor(false);
    assert.notDeepEqual(
      render({ decision: "deny", reason: "r" }, event),
      render({ decision: "allow" }, event),
    );
  });

  it("throws on a non-boolean this_call_vetoable instead of guessing", () => {
    assert.throws(
      () => render({ decision: "deny" }, eventFor("true")),
      /this_call_vetoable must be a boolean, got "true"/,
    );
  });
});
