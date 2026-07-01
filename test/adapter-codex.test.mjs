import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexAdapter, canEnforce } from "../src/adapters/codex.mjs";
import { runAdapterConformance } from "../src/conformance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, "..", "src", "fixtures", "codex.json"), "utf8"),
);

describe("codex adapter conformance", () => {
  it("parse/render golden across PreToolUse, PermissionRequest, and the version gate", () => {
    const summary = runAdapterConformance({
      adapter: codexAdapter,
      fixtures,
      assert,
    });
    assert.ok(summary.cases >= 3);
    assert.equal(summary.mutationSeen, true);
    assert.equal(summary.enforcedDenySeen, true);
    for (const decision of ["allow", "deny", "ask"])
      assert.ok(summary.decisionsSeen.has(decision));
  });

  it("declares AGENT and external_hook integration", () => {
    assert.equal(codexAdapter.AGENT, "codex");
    assert.equal(codexAdapter.INTEGRATION_MODE, "external_hook");
  });
});

describe("canEnforce version gate (≥ v0.135)", () => {
  // Driven per boundary so the major/minor/invalid branches are each pinned.
  for (const [version, expected] of [
    ["0.135.0", true],
    ["0.200.1", true],
    ["1.0.0", true],
    ["0.134.9", false],
    ["", false],
    ["abc", false],
    ["0", false],
  ]) {
    it(`${JSON.stringify(version)} -> ${expected}`, () => {
      assert.equal(canEnforce(version), expected);
    });
  }
});
