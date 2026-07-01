import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ampAdapter } from "../src/adapters/amp.mjs";
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
