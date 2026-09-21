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

describe("claude render: an enforced deny repeats its reason on stderr", () => {
  const preTool = claudeAdapter.parse({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /" },
  });
  // Claude Code parses hook stdout as JSON only on exit 0; the exit-2 block
  // discards it and reads stderr. So the stdout `permissionDecisionReason`
  // below is not a channel the model reads on this path — stderr is.
  it("carries the reason on fd 2 as well as in the discarded body", () => {
    const out = claudeAdapter.render(
      { decision: "deny", reason: "blocked rm" },
      preTool,
    );
    assert.equal(out.enforced, true);
    assert.equal(out.exit_code, 2);
    assert.equal(out.stderr, "blocked rm");
    assert.equal(
      out.stdout.hookSpecificOutput.permissionDecisionReason,
      "blocked rm",
    );
  });

  it("a PostToolUse block carries it too (exit 2 discards stdout there as well)", () => {
    const postTool = claudeAdapter.parse({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat secrets" },
      tool_response: "AKIA-not-a-real-key",
    });
    assert.equal(
      claudeAdapter.render({ decision: "deny", reason: "leak" }, postTool)
        .stderr,
      "leak",
    );
  });

  // The negative half: a verdict that blocked NOTHING must not write to fd 2.
  // Claude Code shows hook stderr on a 0 exit only in verbose/debug, so this is
  // about the claim, not the noise — stderr is the contract's block-reason
  // channel, and writing it for an allow, an ask, or a deny this call cannot
  // veto reports a block that never happened.
  it("an allow, an ask and an unenforceable deny write nothing to fd 2", () => {
    const nonVetoable = { ...preTool, this_call_vetoable: false };
    for (const [verdict, event] of [
      [{ decision: "allow" }, preTool],
      [{ decision: "ask", reason: "confirm" }, preTool],
      [{ decision: "deny", reason: "cannot veto this" }, nonVetoable],
    ]) {
      const out = claudeAdapter.render(verdict, event);
      assert.equal(out.enforced, false);
      assert.equal(
        "stderr" in out,
        false,
        `${verdict.decision} blocked nothing but wrote a block reason to stderr`,
      );
    }
  });

  it("an enforced deny with no reason writes no empty stderr", () => {
    const out = claudeAdapter.render({ decision: "deny" }, preTool);
    assert.equal(out.enforced, true);
    assert.equal("stderr" in out, false);
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
