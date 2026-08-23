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

describe("claude adapter: allow = abstain by default, soleGate opt-in", () => {
  const event = claudeAdapter.parse({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });

  it("default render never emits permissionDecision on allow", () => {
    const out = claudeAdapter.render({ decision: "allow" }, event);
    assert.ok(!("permissionDecision" in out.stdout.hookSpecificOutput));
    assert.equal(out.enforced, false);
    assert.equal(out.exit_code, 0);
  });

  it("soleGate: false (explicit) still abstains", () => {
    const out = claudeAdapter.render({ decision: "allow" }, event, {
      soleGate: false,
    });
    assert.ok(!("permissionDecision" in out.stdout.hookSpecificOutput));
  });

  it("soleGate: true emits the real permissionDecision: allow", () => {
    const out = claudeAdapter.render({ decision: "allow" }, event, {
      soleGate: true,
    });
    assert.equal(out.stdout.hookSpecificOutput.permissionDecision, "allow");
    assert.equal(out.enforced, false);
    assert.equal(out.exit_code, 0);
  });

  it("soleGate: true does not change deny/ask rendering", () => {
    const denyDefault = claudeAdapter.render(
      { decision: "deny", reason: "r" },
      event,
    );
    const denySoleGate = claudeAdapter.render(
      { decision: "deny", reason: "r" },
      event,
      { soleGate: true },
    );
    assert.deepEqual(denyDefault, denySoleGate);
  });
});

describe("claude render: updatedToolOutput is a PostToolUse-only channel", () => {
  const postTool = claudeAdapter.parse({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat secrets" },
    tool_response: "AKIA-not-a-real-key",
  });
  const promptSubmit = claudeAdapter.parse({
    hook_event_name: "UserPromptSubmit",
    prompt: "hello",
  });
  const redaction = { decision: "allow", mutated_output: "[REDACTED]" };

  it("PostToolUse carries the replacement output", () => {
    const out = claudeAdapter.render(redaction, postTool);
    assert.equal(out.stdout.hookSpecificOutput.updatedToolOutput, "[REDACTED]");
  });

  it("UserPromptSubmit drops it — there is no tool output to replace", () => {
    // Emitting it there names a key the host ignores, which reads back to the
    // caller as a redaction that was applied.
    const out = claudeAdapter.render(redaction, promptSubmit);
    assert.equal(
      Object.hasOwn(out.stdout.hookSpecificOutput, "updatedToolOutput"),
      false,
    );
  });

  it("additionalContext still reaches both", () => {
    for (const event of [postTool, promptSubmit])
      assert.equal(
        claudeAdapter.render(
          { decision: "allow", additional_context: "note" },
          event,
        ).stdout.hookSpecificOutput.additionalContext,
        "note",
      );
  });
});
