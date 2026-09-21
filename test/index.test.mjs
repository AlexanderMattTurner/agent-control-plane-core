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
    "baseMeta",
    "STANDARD_META_FIELDS",
    "nativeResponse",
    "asObject",
    "asString",
    "asStringOrNull",
    "VERDICT_CONTENT_FIELDS",
    "UNRENDERED_ON_UNKNOWN",
    // adapters + harness
    "claudeAdapter",
    "codexAdapter",
    "ampAdapter",
    "geminiAdapter",
    "HookEvent",
    "POST_TOOL_REDACTION_UNSUPPORTED",
    // registry
    "ADAPTERS",
    "AGENT_IDS",
    "adapterFor",
    "assertRegistryConsistent",
    // conformance
    "runAdapterConformance",
    "assertCoverageWellFormed",
    "assertToolAliasesCovered",
    "assertAliasedInputsCanonical",
  ];

  for (const name of expected) {
    it(`exports ${name}`, () => {
      assert.ok(name in pkg, `missing export: ${name}`);
    });
  }

  it("adapters expose the { AGENT, COVERAGE, UNRENDERED_FIELDS, NATIVE_ASK_TIER, parse, render } shape", () => {
    for (const adapter of [
      pkg.claudeAdapter,
      pkg.codexAdapter,
      pkg.ampAdapter,
      pkg.geminiAdapter,
    ]) {
      assert.equal(typeof adapter.AGENT, "string");
      assert.equal(typeof adapter.parse, "function");
      assert.equal(typeof adapter.render, "function");
      // Every content field it drops is declared, per conformance rule ⑩.
      assert.equal(typeof adapter.UNRENDERED_FIELDS, "object");
      // Every adapter's coverage matrix is well-formed against the contract SSOT.
      pkg.assertCoverageWellFormed(adapter, assert);
      // Rule ⑪: whether this host honours a distinct ask tier. A consumer reads
      // it to decide where an `ask` has to be escalated to a `deny`, so a
      // missing one would read as `undefined` — falsy, i.e. "escalate here".
      assert.equal(typeof adapter.NATIVE_ASK_TIER, "boolean");
    }
  });

  // Pin each adapter's ask-tier declaration member by member, the way the
  // coverage rows below are pinned: the value decides whether a consumer turns
  // every `ask` on that host into a `deny`, so a flip needs the same evidence a
  // coverage cell does. The conformance harness holds each one to the adapter's
  // real render; this says which answer the package ships.
  it("pins whether each host honours a distinct ask tier", () => {
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(pkg.ADAPTERS).map(([agent, adapter]) => [
          agent,
          adapter.NATIVE_ASK_TIER,
        ]),
      ),
      {
        // permissionDecision: "ask" suspends the call for the user.
        claude: true,
        // Reads the same field and classifies "ask" UNSUPPORTED, then runs the
        // tool: upstream's own test for that path is named
        // `unsupported_permission_decision_fails_open`. PermissionRequest is no
        // ask tier either — its behavior enum is allow and deny.
        codex: false,
        // Exit 1 is Amp's ask, distinct from its allow (0) and reject (2).
        amp: true,
        // No ask vocabulary at all: the render spends the advisory
        // `decision: "deny"` on an ask, so an un-escalated ask runs the tool.
        gemini: false,
      },
    );
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
      subagent: "partial",
      resumed: "partial",
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
