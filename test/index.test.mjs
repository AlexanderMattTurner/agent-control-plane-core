import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as pkg from "../src/index.mjs";

// The barrel is the package's public API surface: pin the exported names so an
// accidental drop (or a subpath-only export) is a failing test, not a silent
// breaking change for consumers.
describe("public API surface (index barrel)", () => {
  const expected = [
    // contract
    "CONTROL_PLANE_SCHEMA",
    "SCHEMA_VERSION",
    "EventKind",
    "Decision",
    "IntegrationMode",
    "CallClass",
    "CALL_CLASSES",
    "CoverageStatus",
    "coverageAllowsVeto",
    "isCoverageStatus",
    "MODELED_TOOLS",
    "TOOL_ALIASES",
    "canonicalTool",
    "assertAliasTargetsModeled",
    "makeEvent",
    "normalizeVerdict",
    "collectPassthrough",
    "nativeResponse",
    "asObject",
    "asString",
    "asStringOrNull",
    // adapters + harness
    "claudeAdapter",
    "codexAdapter",
    "ampAdapter",
    "geminiAdapter",
    "HookEvent",
    "runAdapterConformance",
    "assertCoverageWellFormed",
    "assertToolAliasesCovered",
  ];

  for (const name of expected) {
    it(`exports ${name}`, () => {
      assert.ok(name in pkg, `missing export: ${name}`);
    });
  }

  it("adapters expose the { AGENT, COVERAGE, parse, render } shape", () => {
    for (const adapter of [
      pkg.claudeAdapter,
      pkg.codexAdapter,
      pkg.ampAdapter,
      pkg.geminiAdapter,
    ]) {
      assert.equal(typeof adapter.AGENT, "string");
      assert.equal(typeof adapter.parse, "function");
      assert.equal(typeof adapter.render, "function");
      // Every adapter's coverage matrix is well-formed against the contract SSOT.
      pkg.assertCoverageWellFormed(adapter, assert);
    }
  });

  // Pin each adapter's hook-coverage row (docs/hook-coverage-matrix.md). A cell
  // may only flip on real evidence — an item-⑤ probe promoting an ❓, or a fix
  // closing a hole — so an accidental flip is a failing test, not a silent
  // change to what the guardrail claims it can veto.
  it("pins each adapter's hook-coverage matrix row", () => {
    assert.deepEqual(pkg.claudeAdapter.COVERAGE, {
      builtin: "covered",
      mcp: "covered",
      subagent: "covered",
      resumed: "covered",
    });
    assert.deepEqual(pkg.codexAdapter.COVERAGE, {
      builtin: "partial",
      mcp: "uncovered",
      subagent: "unknown",
      resumed: "unknown",
    });
    assert.deepEqual(pkg.ampAdapter.COVERAGE, {
      builtin: "covered",
      mcp: "covered",
      subagent: "covered",
      resumed: "unknown",
    });
    assert.deepEqual(pkg.geminiAdapter.COVERAGE, {
      builtin: "covered",
      mcp: "unknown",
      subagent: "unknown",
      resumed: "unknown",
    });
  });
});
