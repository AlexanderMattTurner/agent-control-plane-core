import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end integration: run the hook entry as a real subprocess, feed a native
// payload on stdin, and assert the transport actually delivers — the exit code
// and stdout body a real agent would read. This is the only test that exercises
// parse → judge → render as a process boundary, not an in-process call.
const bin = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "agent-hook.mjs",
);

function runHook(agent, payload) {
  const res = spawnSync("node", [bin, "--agent", agent], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return {
    code: res.status,
    stdout: res.stdout,
    json: res.stdout ? JSON.parse(res.stdout) : null,
  };
}

describe("integration: adapter transports over a real process boundary", () => {
  it("claude deny → exit 2 + permissionDecision deny in stdout", () => {
    const out = runHook("claude", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    assert.equal(out.code, 2);
    assert.equal(out.json.hookSpecificOutput.permissionDecision, "deny");
  });

  it("claude allow → exit 0 + permissionDecision allow", () => {
    const out = runHook("claude", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    assert.equal(out.code, 0);
    assert.equal(out.json.hookSpecificOutput.permissionDecision, "allow");
  });

  it("amp deny → exit 2 with NO stdout body (pure exit-code transport)", () => {
    const out = runHook("amp", {
      tool: "Bash",
      input: { command: "rm -rf /tmp" },
    });
    assert.equal(out.code, 2);
    assert.equal(out.stdout, "");
  });

  it("codex ≥v0.135 deny → exit 2 (enforcing)", () => {
    const out = runHook("codex", {
      hook_event_name: "PreToolUse",
      version: "0.135.0",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    assert.equal(out.code, 2);
    assert.equal(out.json.hookSpecificOutput.permissionDecision, "deny");
  });

  it("codex <v0.135 deny → exit 0 (advisory, cannot enforce)", () => {
    const out = runHook("codex", {
      hook_event_name: "PreToolUse",
      version: "0.134.0",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    assert.equal(out.code, 0);
    assert.equal(out.json.hookSpecificOutput.permissionDecision, "deny");
  });

  it("unknown --agent → exit 64", () => {
    const res = spawnSync("node", [bin, "--agent", "nope"], {
      input: "{}",
      encoding: "utf8",
    });
    assert.equal(res.status, 64);
  });
});
