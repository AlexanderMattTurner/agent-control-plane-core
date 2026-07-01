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
    "MODELED_TOOLS",
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
    "HookEvent",
    "runAdapterConformance",
  ];

  for (const name of expected) {
    it(`exports ${name}`, () => {
      assert.ok(name in pkg, `missing export: ${name}`);
    });
  }

  it("adapters expose the { AGENT, parse, render } shape", () => {
    for (const adapter of [
      pkg.claudeAdapter,
      pkg.codexAdapter,
      pkg.ampAdapter,
    ]) {
      assert.equal(typeof adapter.AGENT, "string");
      assert.equal(typeof adapter.parse, "function");
      assert.equal(typeof adapter.render, "function");
    }
  });
});
