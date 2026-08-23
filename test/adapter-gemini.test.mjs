import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  geminiAdapter,
  GEMINI_TOOL_ALIASES,
  POST_TOOL_REDACTION_UNSUPPORTED,
} from "../src/adapters/gemini.mjs";
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

describe("gemini render: AfterTool has no output-mutation channel", () => {
  const event = geminiAdapter.parse({
    hook_event_name: "AfterTool",
    tool_name: "run_shell_command",
    tool_input: { command: "cat secrets" },
    tool_response: "AKIA-not-a-real-key",
  });

  it("a redaction verdict warns the model instead of rendering a bare allow", () => {
    // The leak this closes: AfterTool is gated, so a redaction verdict reaches
    // this adapter, and Gemini documents no field to replace the output with.
    // The render used to be an empty exit 0, so the raw output reached the model
    // reading as vetted.
    const out = geminiAdapter.render(
      { decision: "allow", mutated_output: "cat secrets\n[REDACTED]" },
      event,
    );
    assert.equal(out.exit_code, 0);
    assert.equal(out.enforced, false);
    assert.deepEqual(out.stdout, {
      systemMessage: POST_TOOL_REDACTION_UNSUPPORTED,
    });
  });

  it("the replacement output itself never reaches the wire", () => {
    const out = geminiAdapter.render(
      { decision: "allow", mutated_output: "the-redacted-replacement" },
      event,
    );
    assert.equal(
      JSON.stringify(out).includes("the-redacted-replacement"),
      false,
    );
  });

  it("the warning follows any context the same verdict carries", () => {
    const out = geminiAdapter.render(
      {
        decision: "allow",
        mutated_output: "redacted",
        additional_context: "removed 1 secret",
      },
      event,
    );
    assert.deepEqual(out.stdout, {
      systemMessage: `removed 1 secret\n\n${POST_TOOL_REDACTION_UNSUPPORTED}`,
    });
  });

  it("mutated_input is dropped after the tool has already run", () => {
    // tool_input is a BeforeTool channel; emitting it on AfterTool names a key
    // the host ignores while reading to the caller as a mutation applied.
    const out = geminiAdapter.render(
      { decision: "allow", mutated_input: { command: "echo safe" } },
      event,
    );
    assert.equal(out.stdout, undefined);
  });
});

describe("gemini adapter-scoped builtin tool aliases", () => {
  it("pins the scoped alias map exactly (frozen)", () => {
    assert.ok(Object.isFrozen(GEMINI_TOOL_ALIASES));
    // `web_fetch` is absent on purpose: `WebFetch` advertises `input.url` and
    // Gemini's payload carries only a prose `prompt`, so the alias handed a
    // domain deny-lister an undefined target and it allowed the fetch.
    assert.deepEqual(GEMINI_TOOL_ALIASES, {
      read_file: "Read",
      write_file: "Write",
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

  it("renames read_file's absolute_path to the file_path Read advertises", () => {
    // The bypass: a judge keyed on the canonical `Read` reads `input.file_path`.
    // With the native `absolute_path` forwarded it read `undefined` and allowed,
    // having been told by `event.tool` that it was inspecting a Read.
    const event = geminiAdapter.parse({
      hook_event_name: "BeforeTool",
      tool_name: "read_file",
      tool_input: { absolute_path: "/etc/passwd" },
    });
    assert.equal(event.tool, "Read");
    assert.deepEqual(event.input, { file_path: "/etc/passwd" });
    assert.equal(event.meta.native_tool, "read_file");
  });

  it("renames only for BUILTIN calls, leaving an MCP dialect alone", () => {
    const event = geminiAdapter.parse({
      hook_event_name: "BeforeTool",
      tool_name: "read_file",
      tool_input: { absolute_path: "/etc/passwd" },
      mcp_context: { server: "fs" },
    });
    assert.equal(event.tool, "read_file");
    assert.deepEqual(event.input, { absolute_path: "/etc/passwd" });
  });

  it("leaves web_fetch native, so a judge cannot mistake it for a WebFetch", () => {
    // Gemini carries the target inside a prose prompt with no url field, so the
    // alias could only have been honoured by guessing one. A judge that gates on
    // a guessed destination is worse than one that does not recognise the tool.
    const event = geminiAdapter.parse({
      hook_event_name: "BeforeTool",
      tool_name: "web_fetch",
      tool_input: { prompt: "summarize https://evil.example" },
    });
    assert.equal(event.tool, "web_fetch");
    assert.equal(event.input.url, undefined);
    assert.deepEqual(event.input, { prompt: "summarize https://evil.example" });
  });

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
    // Gemini honours a deny on BeforeTool/AfterTool/BeforeAgent and nothing
    // else, so an event the adapter cannot name has no veto to report. Claiming
    // one is the error that lies to a guardrail: the transcript shows a block
    // and the host runs the tool anyway.
    const event = geminiAdapter.parse({ hook_event_name: "AfterAgent" });
    assert.equal(event.event, "unknown");
    assert.equal(event.this_call_vetoable, false);
    const out = geminiAdapter.render({ decision: "deny", reason: "r" }, event);
    assert.equal(out.enforced, false);
    assert.equal(out.exit_code, 0);
    // The objection still reaches the operator — only the false claim of
    // enforcement is dropped. stderr is the System Block channel, so an
    // un-enforced deny takes the advisory decision body instead.
    assert.equal(out.stderr, undefined);
    assert.deepEqual(out.stdout, { decision: "deny", reason: "r" });
  });
});
