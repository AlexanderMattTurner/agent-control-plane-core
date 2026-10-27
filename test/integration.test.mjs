import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
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
function runRaw(host, input, env = {}) {
  const res = spawnSync("node", [hookBin(host)], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
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
const runHook = (host, payload, env) =>
  runRaw(host, JSON.stringify(payload), env);

describe("integration: per-host hook transports over a real process boundary", () => {
  it("claude deny → exit 2 + permissionDecision deny in stdout", () => {
    const out = runHook("claude", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    assert.equal(out.code, 2);
    assert.equal(out.json.hookSpecificOutput.permissionDecision, "deny");
    // Claude Code discards hook stdout on an exit-2 block and reads stderr, so
    // the reason has to reach fd 2 end-to-end or the model is told nothing.
    assert.match(out.stderr, /rm -rf blocked/);
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

  it("amp deny → exit 2, no stdout body, reason on stderr", () => {
    const out = runHook("amp", {
      tool: "Bash",
      input: { command: "rm -rf /tmp" },
    });
    assert.equal(out.code, 2);
    assert.equal(out.stdout, "");
    // Amp surfaces the delegate helper's stderr, so the block reaches the user
    // with its rationale instead of a bare rejection.
    assert.match(out.stderr, /rm -rf blocked/);
  });

  // Codex's documented PreToolUse stdin has no `version`, so the launcher pins
  // it through ACP_CODEX_VERSION. Without it a real payload cannot enforce.
  const codexPayload = {
    session_id: "s",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /" },
  };

  it("codex with ACP_CODEX_VERSION ≥0.135 → exit 2, reason on stderr", () => {
    const out = runHook("codex", codexPayload, {
      ACP_CODEX_VERSION: "0.151.0",
    });
    assert.equal(out.code, 2);
    assert.equal(out.json.hookSpecificOutput.permissionDecision, "deny");
    // Codex reads the block reason from stderr on exit 2.
    assert.match(out.stderr, /rm -rf blocked/);
  });

  it("codex with no launcher version and a real payload → exit 0 (advisory)", () => {
    const out = runHook("codex", codexPayload, { ACP_CODEX_VERSION: "" });
    assert.equal(out.code, 0);
    assert.equal(out.stderr, "");
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

// ACP_FAIL_CLOSED=1 swaps every host's fail-safe for that host's enforced block:
// its BLOCK_TRANSPORT exit code, with a reason on stderr. A valid call still
// gets its real verdict, so the option changes only what a FAILURE does.
describe("integration: ACP_FAIL_CLOSED=1 blocks on every host", () => {
  const CLOSED = { ACP_FAIL_CLOSED: "1", ACP_CODEX_VERSION: "0.163.0" };
  for (const host of ["claude", "codex", "amp", "gemini"]) {
    it(`${host} unparseable → exit 2 with a stderr reason, no body`, () => {
      const out = runRaw(host, "not json at all {{{", CLOSED);
      assert.equal(out.code, 2);
      assert.equal(out.stdout, "");
      assert.match(out.stderr, /\[acp\] hook pipeline error: /u);
      assert.match(out.stderr, /ACP_FAIL_CLOSED blocks the call/u);
    });
  }

  it("claude allow still exits 0 under ACP_FAIL_CLOSED=1", () => {
    const out = runHook(
      "claude",
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
      CLOSED,
    );
    assert.equal(out.code, 0);
  });

  it("an unrecognized ACP_FAIL_CLOSED value refuses to start", () => {
    const out = runRaw("claude", "{}", { ACP_FAIL_CLOSED: "yes" });
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /ACP_FAIL_CLOSED must be "1" or "0"/u);
  });
});

/**
 * Spawn a host entry and leave its stdin open, as a host that never finishes
 * writing would. Resolves with the exit code, stderr and elapsed milliseconds.
 */
function runHung(host, env) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn("node", [hookBin(host)], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(kill);
      child.stdin.destroy();
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started });
    });
  });
}

// A host kills a hung hook and then runs the call. ACP_HOOK_TIMEOUT_MS has the
// entry give its own failure response first.
describe("integration: ACP_HOOK_TIMEOUT_MS answers a hung hook", () => {
  for (const host of ["claude", "codex", "amp", "gemini"])
    it(`${host}: stdin never closes → the fail-closed block at the deadline`, async () => {
      const out = await runHung(host, {
        ACP_FAIL_CLOSED: "1",
        ACP_HOOK_TIMEOUT_MS: "300",
        ACP_CODEX_VERSION: "0.163.0",
      });
      assert.equal(out.signal, null, "the entry was killed, not answered");
      assert.equal(out.code, 2);
      assert.equal(out.stdout, "");
      assert.match(out.stderr, /hook deadline: .*ACP_HOOK_TIMEOUT_MS=300/u);
      assert.match(out.stderr, /ACP_FAIL_CLOSED blocks the call/u);
    });

  it("amp without ACP_FAIL_CLOSED takes its own default (ask) at the deadline", async () => {
    const out = await runHung("amp", { ACP_HOOK_TIMEOUT_MS: "300" });
    assert.equal(out.signal, null);
    assert.equal(out.code, 1);
  });

  it("a payload that arrives in time still gets its verdict", () => {
    const out = runHook(
      "claude",
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      },
      { ACP_FAIL_CLOSED: "1", ACP_HOOK_TIMEOUT_MS: "5000" },
    );
    assert.equal(out.code, 2);
    assert.equal(out.json.hookSpecificOutput.permissionDecision, "deny");
  });

  // A write-only fd as stdin makes every read fail with EBADF, so the stream
  // errors before any payload arrives.
  it("a stdin read error takes the fail-closed block, not a crash", () => {
    const fd = openSync(join(mkdtempSync(join(tmpdir(), "acp-")), "w"), "w");
    try {
      const res = spawnSync("node", [hookBin("claude")], {
        stdio: [fd, "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, ACP_FAIL_CLOSED: "1" },
      });
      assert.equal(res.status, 2);
      assert.match(res.stderr, /hook stdin error: .*EBADF/u);
    } finally {
      closeSync(fd);
    }
  });

  it("an unrecognized ACP_HOOK_TIMEOUT_MS value refuses to start", () => {
    const out = runRaw("claude", "{}", { ACP_HOOK_TIMEOUT_MS: "5s" });
    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /ACP_HOOK_TIMEOUT_MS must be a positive integer/u);
  });
});
