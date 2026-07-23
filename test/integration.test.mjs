import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end integration: run each host's hook entry as a real subprocess, feed a
// native payload on stdin, and assert the transport actually delivers — the exit
// code and stdout body a real agent would read. This is the only suite that
// exercises parse → judge → render across a process boundary, per host entry,
// not as an in-process call.
const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const hookBin = (host) => join(binDir, `${host}-hook.mjs`);

/** Spawn a host entry with a raw stdin string; return exit code + stdout. */
function runRaw(host, input) {
  const res = spawnSync("node", [hookBin(host)], { input, encoding: "utf8" });
  // A missing/renamed bin/<host>-hook.mjs makes spawnSync set `error` and leave
  // status null + empty stdout; assert the spawn itself succeeded so "the bin is
  // gone" fails loudly here instead of as a confusing downstream JSON.parse.
  assert.equal(
    res.error,
    undefined,
    `spawning ${hookBin(host)} failed: ${res.error && res.error.message}`,
  );
  assert.notEqual(res.status, null, `${hookBin(host)} produced no exit status`);
  return {
    code: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    json: res.stdout ? JSON.parse(res.stdout) : null,
  };
}

/** Spawn a host entry with a JSON payload. */
const runHook = (host, payload) => runRaw(host, JSON.stringify(payload));

describe("integration: per-host hook transports over a real process boundary", () => {
  it("claude deny → exit 2 + permissionDecision deny in stdout", () => {
    const out = runHook("claude", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    assert.equal(out.code, 2);
    assert.equal(out.json.hookSpecificOutput.permissionDecision, "deny");
  });

  it("claude allow → exit 0 + NO permissionDecision (never auto-approves)", () => {
    const out = runHook("claude", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    assert.equal(out.code, 0);
    assert.equal(out.json.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(
      "permissionDecision" in out.json.hookSpecificOutput,
      false,
      "an allow must not emit permissionDecision — that would auto-approve",
    );
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

  it("gemini BeforeTool deny → exit 2 System Block, reason on stderr, no stdout", () => {
    const out = runHook("gemini", {
      hook_event_name: "BeforeTool",
      tool_name: "run_shell_command",
      tool_input: { command: "rm -rf /" },
    });
    assert.equal(out.code, 2);
    assert.equal(out.stdout, "");
    // The block reason reaches fd 2 end-to-end (Gemini reads its System Block
    // rationale from stderr) — never a block with no explanation.
    assert.match(out.stderr, /rm -rf blocked/);
  });

  it("gemini BeforeTool allow → exit 0, abstains (no stdout)", () => {
    const out = runHook("gemini", {
      hook_event_name: "BeforeTool",
      tool_name: "run_shell_command",
      tool_input: { command: "echo hi" },
    });
    assert.equal(out.code, 0);
    assert.equal(out.stdout, "");
  });
});

// Hook-suicide: when the guardrail process itself breaks (garbage or empty stdin
// it can't parse), each host entry must degrade the way THAT host expects — NOT
// a single shared default. claude/codex fail OPEN (exit 0, proceed); amp fails to
// ASK (exit 1). The exit codes deliberately differ, so a regression that made
// them uniform is caught here. Every suicide also owes a stderr diagnostic:
// fail-open with zero trace is how an adapter regression silently disables
// enforcement.
describe("integration: hook-suicide fail-safe is per host", () => {
  const DIAGNOSTIC = /\[acp\] hook pipeline error: /;
  for (const garbage of ["not json at all {{{", "", "   "]) {
    const label = JSON.stringify(garbage);
    it(`claude unparseable (${label}) → fail OPEN, exit 0, no body, stderr diagnostic`, () => {
      const out = runRaw("claude", garbage);
      assert.equal(out.code, 0);
      assert.equal(out.stdout, "");
      assert.match(out.stderr, DIAGNOSTIC);
    });

    it(`codex unparseable (${label}) → fail OPEN, exit 0, no body, stderr diagnostic`, () => {
      const out = runRaw("codex", garbage);
      assert.equal(out.code, 0);
      assert.equal(out.stdout, "");
      assert.match(out.stderr, DIAGNOSTIC);
    });

    it(`amp unparseable (${label}) → fail to ASK, exit 1, no body, stderr diagnostic`, () => {
      const out = runRaw("amp", garbage);
      assert.equal(out.code, 1);
      assert.equal(out.stdout, "");
      assert.match(out.stderr, DIAGNOSTIC);
    });

    it(`gemini unparseable (${label}) → fail OPEN, exit 0, no body, stderr diagnostic`, () => {
      const out = runRaw("gemini", garbage);
      assert.equal(out.code, 0);
      assert.equal(out.stdout, "");
      assert.match(out.stderr, DIAGNOSTIC);
    });
  }
});
