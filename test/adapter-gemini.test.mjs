import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { geminiAdapter, GEMINI_TOOL_ALIASES } from "../src/adapters/gemini.mjs";
import { runAdapterConformance } from "../src/conformance.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, "..", "src", "fixtures", "gemini.json"), "utf8"),
);

describe("gemini adapter conformance", () => {
  it("parse/render golden across BeforeTool, AfterTool, BeforeAgent, and passthrough", () => {
    const summary = runAdapterConformance({
      adapter: geminiAdapter,
      fixtures,
      assert,
    });
    assert.ok(summary.cases >= 4);
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
    assert.equal(out.stderr, "r"); // reason carried to fd 2, never dropped
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

describe("gemini adapter-scoped builtin tool aliases", () => {
  it("pins the scoped alias map exactly (frozen)", () => {
    assert.ok(Object.isFrozen(GEMINI_TOOL_ALIASES));
    assert.deepEqual(GEMINI_TOOL_ALIASES, {
      read_file: "Read",
      write_file: "Write",
      web_fetch: "WebFetch",
    });
  });

  // One case per alias member: the map is the SSOT, so adding an entry without
  // a matching parse expectation fails here.
  for (const [nativeName, canonical] of Object.entries(GEMINI_TOOL_ALIASES)) {
    it(`builtin ${nativeName} canonicalizes to ${canonical}, preserving native_tool`, () => {
      const event = geminiAdapter.parse({
        hook_event_name: "BeforeTool",
        tool_name: nativeName,
        tool_input: { x: 1 },
      });
      assert.equal(event.tool, canonical);
      assert.equal(event.meta.native_tool, nativeName);
      assert.equal(event.this_call_vetoable, true);
    });
  }

  it("an MCP FQN is never aliased (mcp_ prefix wins)", () => {
    const event = geminiAdapter.parse({
      hook_event_name: "BeforeTool",
      tool_name: "mcp_fs_read_file",
      tool_input: { path: "/x" },
    });
    assert.equal(event.tool, "mcp_fs_read_file");
    assert.equal(event.this_call_vetoable, false);
  });

  it("an mcp_context-flagged bare read_file is never aliased", () => {
    const event = geminiAdapter.parse({
      hook_event_name: "BeforeTool",
      tool_name: "read_file",
      tool_input: { path: "/x" },
      mcp_context: { server: "fs" },
    });
    assert.equal(event.tool, "read_file");
    assert.equal(event.this_call_vetoable, false);
  });
});

describe("gemini BeforeAgent maps to prompt_submit", () => {
  const event = geminiAdapter.parse({
    hook_event_name: "BeforeAgent",
    session_id: "g2",
    prompt: "do the thing",
    timestamp: "t",
  });

  it("folds prompt into input.prompt with no tool and no native_tool", () => {
    assert.equal(event.event, "prompt_submit");
    assert.equal(event.tool, null);
    assert.deepEqual(event.input, { prompt: "do the thing" });
    assert.ok(!("native_tool" in event.meta));
    assert.equal(event.this_call_vetoable, true);
    assert.deepEqual(event.meta.passthrough, { timestamp: "t" });
  });

  it("coerces a missing/non-string prompt to the empty string", () => {
    const noPrompt = geminiAdapter.parse({ hook_event_name: "BeforeAgent" });
    assert.deepEqual(noPrompt.input, { prompt: "" });
    const badPrompt = geminiAdapter.parse({
      hook_event_name: "BeforeAgent",
      prompt: 42,
    });
    assert.deepEqual(badPrompt.input, { prompt: "" });
  });

  it("enforced deny aborts the turn: exit 2, no stdout, reason on stderr", () => {
    const out = geminiAdapter.render({ decision: "deny", reason: "r" }, event);
    assert.deepEqual(out, {
      transport: "external_hook",
      exit_code: 2,
      enforced: true,
      stderr: "r",
    });
  });

  it("allow abstains — even under soleGate (BeforeAgent documents no allow decision)", () => {
    for (const options of [undefined, { soleGate: true }]) {
      const out = geminiAdapter.render({ decision: "allow" }, event, options);
      assert.deepEqual(out, {
        transport: "external_hook",
        exit_code: 0,
        enforced: false,
      });
    }
  });

  it("ask renders the exit-0 decision: deny body (mirrors BeforeTool's ask)", () => {
    const out = geminiAdapter.render({ decision: "ask", reason: "c" }, event);
    assert.deepEqual(out, {
      transport: "external_hook",
      exit_code: 0,
      enforced: false,
      stdout: { decision: "deny", reason: "c" },
    });
  });

  it("maps additional_context to hookSpecificOutput.additionalContext, not systemMessage", () => {
    const out = geminiAdapter.render(
      { decision: "allow", additional_context: "note" },
      event,
    );
    assert.deepEqual(out.stdout, {
      hookSpecificOutput: { additionalContext: "note" },
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
