import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { demoJudge, renderHookResponse } from "../bin/hook-runtime.mjs";
import { claudeAdapter } from "../src/adapters/claude.mjs";
import { ampAdapter } from "../src/adapters/amp.mjs";

// bin/ is not under the c8 gate (which scopes to src/), so these in-process tests
// exist to pin the runtime's LOGIC with real assertions — the subprocess
// integration suite proves the transport, this proves the judge/fallback.

describe("demoJudge: deny rm -rf, allow otherwise", () => {
  it("denies a command matching rm -rf, with a reason", () => {
    assert.deepEqual(demoJudge({ input: { command: "rm -rf /" } }), {
      decision: "deny",
      reason: "demo policy: rm -rf blocked",
    });
  });

  it("allows a benign command", () => {
    assert.deepEqual(demoJudge({ input: { command: "ls -la" } }), {
      decision: "allow",
    });
  });

  it("allows when command is absent or non-string (no throw)", () => {
    assert.deepEqual(demoJudge({ input: {} }), { decision: "allow" });
    assert.deepEqual(demoJudge({ input: { command: 42 } }), {
      decision: "allow",
    });
  });
});

describe("renderHookResponse: pipes adapter parse→judge→render", () => {
  const claudePayload = (command) =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
    });
  const FAIL = { transport: "external_hook", exit_code: 0, enforced: false };

  it("renders a deny for rm -rf (exit 2, permissionDecision deny)", () => {
    const out = renderHookResponse(
      claudeAdapter,
      claudePayload("rm -rf /"),
      FAIL,
    );
    assert.equal(out.exit_code, 2);
    assert.equal(out.enforced, true);
    assert.equal(out.stdout.hookSpecificOutput.permissionDecision, "deny");
  });

  it("renders an allow that abstains (exit 0, no permissionDecision)", () => {
    const out = renderHookResponse(claudeAdapter, claudePayload("ls"), FAIL);
    assert.equal(out.exit_code, 0);
    assert.equal("permissionDecision" in out.stdout.hookSpecificOutput, false);
  });

  it("returns the host's exact onFailure object on unparseable input", () => {
    // Identity, not just shape: the fallback the host declared is what comes back.
    assert.equal(renderHookResponse(claudeAdapter, "not json {{{", FAIL), FAIL);
    assert.equal(renderHookResponse(claudeAdapter, "", FAIL), FAIL);
  });

  it("writes a greppable diagnostic to stderr on failure, verdict unchanged", () => {
    // The fail direction is deliberate and must stay; the diagnostic is what
    // keeps a silent enforcement-disable regression discoverable.
    const written = [];
    const realWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    let out;
    try {
      out = renderHookResponse(claudeAdapter, "not json {{{", FAIL);
    } finally {
      process.stderr.write = realWrite;
    }
    assert.equal(out, FAIL);
    assert.equal(written.length, 1);
    assert.match(written[0], /^\[acp\] hook pipeline error: /);
    assert.match(written[0], /SyntaxError/);
  });

  it("carries the adapter's transport through (amp = pure exit code)", () => {
    const ampFail = {
      transport: "external_hook",
      exit_code: 1,
      enforced: false,
    };
    const out = renderHookResponse(
      ampAdapter,
      JSON.stringify({ tool: "Bash", input: { command: "rm -rf /tmp" } }),
      ampFail,
    );
    assert.equal(out.exit_code, 2);
    assert.equal(out.stdout, undefined);
  });
});
