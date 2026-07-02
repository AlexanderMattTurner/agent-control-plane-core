import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { geminiAdapter } from "../src/adapters/gemini.mjs";
import { runAdapterConformance } from "../src/conformance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, "..", "src", "fixtures", "gemini.json"), "utf8"),
);

describe("gemini adapter conformance", () => {
  it("parse/render golden across BeforeTool, AfterTool, and passthrough", () => {
    const summary = runAdapterConformance({
      adapter: geminiAdapter,
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
    assert.equal(geminiAdapter.AGENT, "gemini");
    assert.equal(geminiAdapter.INTEGRATION_MODE, "external_hook");
  });
});

describe("gemini render: BeforeTool decision channel", () => {
  const event = geminiAdapter.parse({
    hook_event_name: "BeforeTool",
    tool_name: "run_shell_command",
    tool_input: { command: "echo hi" },
  });

  it("enforced deny is a System Block (exit 2, no stdout — reason via stderr)", () => {
    const out = geminiAdapter.render({ decision: "deny", reason: "r" }, event);
    assert.equal(out.exit_code, 2);
    assert.equal(out.enforced, true);
    assert.equal(out.stdout, undefined);
  });

  it("allow abstains by default (exit 0, no decision body)", () => {
    const out = geminiAdapter.render({ decision: "allow" }, event);
    assert.equal(out.exit_code, 0);
    assert.equal(out.enforced, false);
    assert.equal(out.stdout, undefined);
  });

  it("soleGate: true emits the real decision: allow", () => {
    const out = geminiAdapter.render({ decision: "allow" }, event, {
      soleGate: true,
    });
    assert.equal(out.exit_code, 0);
    assert.equal(out.enforced, false);
    assert.deepEqual(out.stdout, { decision: "allow" });
  });

  it("ask is an exit-0 advisory deny (Gemini has no native ask)", () => {
    const out = geminiAdapter.render(
      { decision: "ask", reason: "confirm" },
      event,
    );
    assert.equal(out.exit_code, 0);
    assert.equal(out.enforced, false);
    assert.deepEqual(out.stdout, { decision: "deny", reason: "confirm" });
  });

  it("maps mutated_input -> hookSpecificOutput.tool_input and context -> systemMessage", () => {
    const out = geminiAdapter.render(
      {
        decision: "allow",
        mutated_input: { command: "echo safe" },
        additional_context: "note",
      },
      event,
    );
    assert.deepEqual(out.stdout, {
      hookSpecificOutput: { tool_input: { command: "echo safe" } },
      systemMessage: "note",
    });
  });
});

describe("gemini parse: never throws, preserves unmodelled fields", () => {
  it("carries mcp_context/original_request_name/timestamp into passthrough", () => {
    const event = geminiAdapter.parse({
      hook_event_name: "BeforeTool",
      tool_name: "read_file",
      tool_input: { path: "/x" },
      mcp_context: { server: "fs" },
      original_request_name: "fs__read_file",
      timestamp: "t",
    });
    assert.deepEqual(event.meta.passthrough, {
      mcp_context: { server: "fs" },
      original_request_name: "fs__read_file",
      timestamp: "t",
    });
  });

  it("does not throw on non-object / array / primitive input", () => {
    for (const bad of [null, 42, "s", [1], undefined])
      assert.doesNotThrow(() => geminiAdapter.parse(bad));
  });

  it("an unknown event kind renders without an enforced block", () => {
    const event = geminiAdapter.parse({ hook_event_name: "AfterAgent" });
    assert.equal(event.event, "unknown");
    const out = geminiAdapter.render({ decision: "deny", reason: "r" }, event);
    // still vetoable=true, so an enforced deny renders exit 2 even on unknown
    assert.equal(out.exit_code, 2);
  });
});
