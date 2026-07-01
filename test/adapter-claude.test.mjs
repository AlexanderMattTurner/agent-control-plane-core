import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeAdapter } from "../src/adapters/claude.mjs";
import { runAdapterConformance } from "../src/conformance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, "..", "src", "fixtures", "claude.json"), "utf8"),
);

describe("claude adapter conformance", () => {
  it("parse/render are golden and an enforced deny carries a real block signal", () => {
    const summary = runAdapterConformance({
      adapter: claudeAdapter,
      fixtures,
      assert,
    });
    assert.ok(summary.cases >= 5);
    assert.equal(summary.mutationSeen, true);
    assert.equal(summary.enforcedDenySeen, true);
    for (const decision of ["allow", "deny", "ask"])
      assert.ok(summary.decisionsSeen.has(decision));
  });

  it("declares AGENT and external_hook integration", () => {
    assert.equal(claudeAdapter.AGENT, "claude");
    assert.equal(claudeAdapter.INTEGRATION_MODE, "external_hook");
  });
});
