import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  demoJudge,
  isRetryableWriteError,
  renderHookResponse,
  writeAllSync,
} from "../src/runtime.mjs";
import { claudeAdapter } from "../src/adapters/claude.mjs";
import { ampAdapter } from "../src/adapters/amp.mjs";

// The runtime is published at `agent-control-plane-core/runtime`, so these
// in-process tests pin its LOGIC with real assertions against the same module a
// consumer imports — the subprocess integration suite proves the transport,
// this proves the judge/fallback.

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

  // A top-level payload that is valid JSON but not an object. Every adapter's
  // `asObject` coerces one to `{}`, so without this refusal the pipeline judges
  // a benign empty tool call and rubber-stamps it with no trace. Driven per
  // SHAPE, because the diagnostic names the shape and each is a separate arm.
  const nonObjectPayloads = {
    null: ["null", /got null/u],
    array: ["[1, 2]", /got array/u],
    number: ["7", /got number/u],
    string: ['"ls"', /got string/u],
  };
  for (const [label, [raw, named]] of Object.entries(nonObjectPayloads))
    it(`refuses a top-level ${label} payload instead of judging {}`, () => {
      const written = [];
      const realWrite = process.stderr.write;
      process.stderr.write = (chunk) => {
        written.push(String(chunk));
        return true;
      };
      let out;
      try {
        out = renderHookResponse(claudeAdapter, raw, FAIL);
      } finally {
        process.stderr.write = realWrite;
      }
      // The fail-safe, not a rendered response: a coerced `{}` would have
      // produced a real one here, which is the silent rubber-stamp refused.
      assert.equal(out, FAIL);
      assert.match(written[0], /TypeError/u);
      assert.match(written[0], /hook payload must be a JSON object/u);
      assert.match(written[0], named);
    });

  // The diagnostic is the only trace a failed pipeline leaves, so it must stay
  // readable whatever was thrown. A judge is consumer code: it can throw a bare
  // string, and an Error can reach here with no `stack` (a subclass that sets
  // none, a structured-clone round trip). Both used to render as "undefined".
  const thrownShapes = {
    "a bare string": ["judge exploded", /judge exploded/u],
    "an Error with no stack": [
      Object.assign(new Error("no stack here"), { stack: undefined }),
      /no stack here/u,
    ],
  };
  for (const [label, [thrown, named]] of Object.entries(thrownShapes))
    it(`reports ${label} in the diagnostic`, () => {
      const written = [];
      const realWrite = process.stderr.write;
      process.stderr.write = (chunk) => {
        written.push(String(chunk));
        return true;
      };
      let out;
      try {
        out = renderHookResponse(
          claudeAdapter,
          claudePayload("ls"),
          FAIL,
          () => {
            throw thrown;
          },
        );
      } finally {
        process.stderr.write = realWrite;
      }
      assert.equal(out, FAIL);
      assert.match(written[0], named);
      assert.doesNotMatch(written[0], /error: undefined/u);
    });

  it("clamps a malformed judge decision to ask instead of failing open", () => {
    // The failure this closes: `normalizeVerdict` throws on a decision outside
    // allow/deny/ask, that throw lands in the pipeline catch, and the catch
    // returns the host's fail-safe — exit 0 for claude. So a judge that MEANT
    // deny but spelled it "denied" used to let the tool run.
    const malformed = () => ({
      decision: "denied",
      reason: "blocked by policy",
    });
    const out = renderHookResponse(
      claudeAdapter,
      claudePayload("ls"),
      FAIL,
      malformed,
    );
    assert.notEqual(out, FAIL, "malformed verdict took the fail-open path");
    assert.equal(
      out.stdout.hookSpecificOutput.permissionDecision,
      "ask",
      "malformed decision did not clamp to ask",
    );
    // The clamp names the rejected value, so an operator can see what the judge
    // actually said rather than a bare prompt.
    assert.match(
      out.stdout.hookSpecificOutput.permissionDecisionReason,
      /clamped to "ask"/,
    );
  });

  it("still renders a well-formed judge verdict untouched", () => {
    // Positive marker: the clamp is not swallowing ordinary verdicts, so the
    // case above is the malformed path and not a blanket rewrite.
    const denying = () => ({ decision: "deny", reason: "no" });
    const out = renderHookResponse(
      claudeAdapter,
      claudePayload("ls"),
      FAIL,
      denying,
    );
    assert.equal(out.stdout.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(out.enforced, true);
    assert.notEqual(out.exit_code, 0);
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

// A deny body can exceed a pipe buffer (a judge quoting the offending input into
// `reason`, or a large `mutated_input`). `emit` must deliver ALL of it: a
// truncated JSON body is an enforced deny the host cannot parse — a silent
// deny→allow. Driven as a subprocess because the bug only exists on a real
// non-blocking pipe.
// The predicate `writeAllSync` retries on. Only EAGAIN means "the kernel asked
// you to repeat this write"; treating anything else as retryable turns a real
// failure into a hang, and treating EAGAIN as fatal is the short write that
// truncates a deny body into a run.
describe("isRetryableWriteError: EAGAIN alone is retryable", () => {
  const cases = {
    "an EAGAIN error": [
      Object.assign(new Error("again"), { code: "EAGAIN" }),
      true,
    ],
    "an EPIPE error": [
      Object.assign(new Error("pipe"), { code: "EPIPE" }),
      false,
    ],
    "an error with no code": [new Error("bare"), false],
    // A plain object is not a write the kernel asked us to repeat, so retrying
    // it forever would hang instead of propagating.
    "a non-Error carrying code EAGAIN": [{ code: "EAGAIN" }, false],
    "a thrown string": ["EAGAIN", false],
    null: [null, false],
  };
  for (const [label, [err, expected]] of Object.entries(cases))
    it(`${expected ? "retries" : "propagates"} ${label}`, () => {
      assert.equal(isRetryableWriteError(err), expected);
    });
});

describe("writeAllSync: a write it cannot repeat propagates", () => {
  it("writes every byte to a real descriptor", () => {
    const path = join(mkdtempSync(join(tmpdir(), "acp-write-")), "out");
    const fd = openSync(path, "w");
    try {
      writeAllSync(fd, "café ☕");
    } finally {
      closeSync(fd);
    }
    assert.equal(readFileSync(path, "utf8"), "café ☕");
  });

  it("propagates a non-retryable errno instead of looping on it", () => {
    // A real closed descriptor, so a real EBADF from the real `writeSync`. The
    // loop has no retry cap, so treating this as retryable would hang the hook
    // forever rather than fail it.
    const fd = openSync("/dev/null", "w");
    closeSync(fd);
    assert.throws(() => writeAllSync(fd, "x"), /EBADF/u);
  });
});

describe("emit: writes a body larger than the pipe buffer in full", () => {
  const fixture = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "emit-large-body-fixture.mjs",
  );

  const stringStdin = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "string-stdin-fixture.mjs",
  );

  it("reads a payload from a stdin that hands it strings", () => {
    // A multi-byte character so a decoder that mishandles the chunk boundary
    // shows up as mangled text rather than as an equal-length pass.
    const payload = '{"tool_input":{"command":"echo café ☕"}}';
    const res = spawnSync("node", [stringStdin], {
      encoding: "utf8",
      input: payload,
    });
    assert.equal(res.error, undefined, `spawn failed: ${res.error?.message}`);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.equal(res.stdout, payload);
  });

  for (const padBytes of [200_000, 2_000_000]) {
    it(`delivers a ${padBytes}-byte deny reason intact (exit 2)`, () => {
      const res = spawnSync("node", [fixture, `--pad=${padBytes}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      assert.equal(res.error, undefined, `spawn failed: ${res.error?.message}`);
      assert.equal(res.status, 2, `stderr: ${res.stderr}`);
      const body = JSON.parse(res.stdout).hookSpecificOutput;
      assert.equal(body.permissionDecision, "deny");
      assert.equal(body.permissionDecisionReason.length, padBytes);
    });
  }
});
