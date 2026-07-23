import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHookConfig,
  writeHookConfig,
} from "../.github/scripts/live-capture/write-hook-config.mjs";
import { assertCaptured } from "../.github/scripts/live-capture/assert-captured.mjs";

// Tier-2 live-capture harness. The live model turn can't run here (no CLIs, no
// credentials), but the deterministic halves — generating each agent's capture
// hook config, and asserting a captured payload still parses — are pinned with
// real assertions, the latter driven by the golden fixtures' own native payloads
// (the closest stand-in for "a real emission" available offline).

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (agent) =>
  JSON.parse(
    readFileSync(join(here, "..", "src", "fixtures", `${agent}.json`), "utf8"),
  );

const DUMP = "node /abs/dump.mjs";
const DUMP_BIN = join(
  here,
  "..",
  ".github",
  "scripts",
  "live-capture",
  "dump.mjs",
);

// dump.mjs is a real subprocess a live agent's hook dispatcher invokes — it is
// never called by any of the unit tests below (those only assert what COMMAND
// STRING gets generated). This is a regression test for a real first-dispatch
// bug: Gemini CLI runs hooks with a sandboxed env, so ACP_CAPTURE_FILE never
// reached dump.mjs even though the parent gemini process had it. The fix moved
// the target path onto the command line as a NAMED --capture-file=<path> flag
// (searched by prefix, not a bare positional index) so a prepended argument —
// ours or a host's — can never silently shift which value gets read; this
// drives the actual binary to prove the fix and pin the fallback/failure
// behavior.
describe("dump.mjs: capture target via --capture-file flag, with env fallback", () => {
  // cwd is pinned to the per-test temp dir — NOT the repo root — so a bug in
  // dump.mjs that resolves a relative path (e.g. reading the wrong argv slot)
  // writes a stray file into a directory this test deletes, never into the
  // working tree. Merge onto process.env (for PATH etc.) rather than replacing
  // it outright; explicitly delete ACP_CAPTURE_FILE first so a real CI env
  // can't leak one in.
  const run = (base, argv, envOverrides, stdin) => {
    const env = { ...process.env, ...envOverrides };
    delete env.ACP_CAPTURE_FILE;
    if (envOverrides.ACP_CAPTURE_FILE)
      env.ACP_CAPTURE_FILE = envOverrides.ACP_CAPTURE_FILE;
    const res = spawnSync("node", [DUMP_BIN, ...argv], {
      cwd: base,
      env,
      input: stdin ?? "",
      encoding: "utf8",
    });
    // A missing/renamed dump.mjs makes spawnSync set `error` and leave status
    // null; assert the spawn itself ran so "the bin is gone" fails loudly here
    // rather than as a misleading status/stderr assertion downstream.
    assert.equal(
      res.error,
      undefined,
      `spawning ${DUMP_BIN} failed: ${res.error && res.error.message}`,
    );
    assert.notEqual(res.status, null, `${DUMP_BIN} produced no exit status`);
    return res;
  };

  it("writes stdin to the --capture-file target and exits 0, even with no env at all", () => {
    const base = mkdtempSync(join(tmpdir(), "acp-dump-"));
    try {
      const target = join(base, "out.json");
      const res = run(
        base,
        [`--capture-file=${target}`],
        {},
        '{"hook_event_name":"BeforeTool"}',
      );
      assert.equal(res.status, 0);
      assert.equal(
        readFileSync(target, "utf8"),
        '{"hook_event_name":"BeforeTool"}',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("finds --capture-file even with an unrelated flag prepended", () => {
    const base = mkdtempSync(join(tmpdir(), "acp-dump-"));
    try {
      const target = join(base, "out.json");
      // Proves the fix: a positional index would have silently read "--verbose"
      // instead of the real target here.
      const res = run(base, ["--verbose", `--capture-file=${target}`], {}, "y");
      assert.equal(res.status, 0);
      assert.equal(readFileSync(target, "utf8"), "y");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("falls back to ACP_CAPTURE_FILE when no flag is given", () => {
    const base = mkdtempSync(join(tmpdir(), "acp-dump-"));
    try {
      const target = join(base, "out.json");
      const res = run(base, [], { ACP_CAPTURE_FILE: target }, "payload");
      assert.equal(res.status, 0);
      assert.equal(readFileSync(target, "utf8"), "payload");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("prefers --capture-file over ACP_CAPTURE_FILE when both are present", () => {
    const base = mkdtempSync(join(tmpdir(), "acp-dump-"));
    try {
      const flagTarget = join(base, "flag.json");
      const envTarget = join(base, "env.json");
      const res = run(
        base,
        [`--capture-file=${flagTarget}`],
        { ACP_CAPTURE_FILE: envTarget },
        "x",
      );
      assert.equal(res.status, 0);
      assert.equal(readFileSync(flagTarget, "utf8"), "x");
      assert.equal(existsSync(envTarget), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("fails loud (exit 1, stderr) when neither the flag nor env supplies a target", () => {
    const base = mkdtempSync(join(tmpdir(), "acp-dump-"));
    try {
      const res = run(base, [], {});
      assert.equal(res.status, 1);
      assert.match(res.stderr, /no capture target/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("buildHookConfig points each agent's pre-tool hook at the dumper", () => {
  it("claude → .claude/settings.json PreToolUse command hook", () => {
    const cfg = buildHookConfig("claude", {
      dumpCommand: DUMP,
      matcher: "Bash",
    });
    assert.deepEqual(cfg.env, {});
    assert.equal(cfg.files.length, 1);
    assert.equal(cfg.files[0].rel, ".claude/settings.json");
    const body = JSON.parse(cfg.files[0].content);
    const entry = body.hooks.PreToolUse[0];
    assert.equal(entry.matcher, "Bash");
    assert.equal(entry.hooks[0].type, "command");
    assert.equal(entry.hooks[0].command, DUMP);
  });

  it("codex → config.toml with matcher + command, CODEX_HOME env", () => {
    const cfg = buildHookConfig("codex", {
      dumpCommand: DUMP,
      matcher: "^Bash$",
    });
    assert.equal(cfg.env.CODEX_HOME, "codex-home");
    assert.equal(cfg.files[0].rel, "codex-home/config.toml");
    assert.match(cfg.files[0].content, /\[\[hooks\.PreToolUse\]\]/);
    assert.match(cfg.files[0].content, /matcher = "\^Bash\$"/);
    assert.match(cfg.files[0].content, /command = "node \/abs\/dump\.mjs"/);
  });

  it("codex with a provider adds an OpenAI-compatible model_providers block", () => {
    const cfg = buildHookConfig("codex", {
      dumpCommand: DUMP,
      matcher: "^Bash$",
      provider: {
        name: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        envKey: "OPENROUTER_API_KEY",
        model: "openai/gpt-4o-mini",
      },
    });
    const toml = cfg.files[0].content;
    // TOML: the top-level model_provider/model keys MUST precede any table.
    assert.ok(
      toml.indexOf("model_provider =") < toml.indexOf("[[hooks.PreToolUse]]"),
    );
    assert.match(toml, /model_provider = "openrouter"/);
    assert.match(toml, /model = "openai\/gpt-4o-mini"/);
    assert.match(toml, /\[model_providers\.openrouter\]/);
    assert.match(toml, /base_url = "https:\/\/openrouter\.ai\/api\/v1"/);
    assert.match(toml, /env_key = "OPENROUTER_API_KEY"/);
    // OpenRouter/Venice only speak chat completions, never the Responses API.
    assert.match(toml, /wire_api = "chat"/);
  });

  it("codex without a provider stays a plain hook config (no model_provider)", () => {
    const cfg = buildHookConfig("codex", {
      dumpCommand: DUMP,
      matcher: "^Bash$",
    });
    assert.doesNotMatch(cfg.files[0].content, /model_provider/);
  });

  it("amp → delegate permission entry (best-effort)", () => {
    const cfg = buildHookConfig("amp", { dumpCommand: DUMP, matcher: "Bash" });
    const body = JSON.parse(cfg.files[0].content);
    assert.equal(body["amp.permissions"][0].action, "delegate");
    assert.equal(body["amp.permissions"][0].command, DUMP);
    assert.equal(body["amp.permissions"][0].tool, "Bash");
  });

  it("gemini → .gemini/settings.json BeforeTool command hook", () => {
    const cfg = buildHookConfig("gemini", {
      dumpCommand: DUMP,
      matcher: "run_shell_command",
    });
    assert.deepEqual(cfg.env, {});
    assert.equal(cfg.files[0].rel, ".gemini/settings.json");
    const entry = JSON.parse(cfg.files[0].content).hooks.BeforeTool[0];
    assert.equal(entry.matcher, "run_shell_command");
    assert.equal(entry.hooks[0].command, DUMP);
  });

  it("throws on an unknown agent", () => {
    assert.throws(
      () => buildHookConfig("nope", { dumpCommand: DUMP, matcher: "x" }),
      /unknown agent nope/,
    );
  });
});

describe("writeHookConfig lands files on disk and resolves env to absolute", () => {
  it("writes codex config and makes CODEX_HOME absolute under baseDir", () => {
    const base = mkdtempSync(join(tmpdir(), "acp-live-"));
    try {
      const { written, env } = writeHookConfig("codex", base, {
        dumpCommand: DUMP,
        matcher: "^Bash$",
      });
      assert.equal(written.length, 1);
      assert.ok(env.CODEX_HOME.startsWith(base));
      assert.match(
        readFileSync(written[0], "utf8"),
        /\[\[hooks\.PreToolUse\]\]/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("assertCaptured accepts a real emission, rejects a broken one", () => {
  it("returns the full golden event through the live-capture gate, not just the shape", () => {
    // This drives assertCaptured — the live-capture acceptance gate, which
    // conformance never calls — so it is additive despite round-tripping the same
    // fixtures. Strengthened past the old event/tool spot-checks: deep-equal the
    // returned event against the fixture's DECLARED event, proving the gate
    // returns the parse result faithfully (dropping/altering a field here would
    // pass a shape check but fail this) while its tool/input validation accepts.
    for (const agent of ["claude", "codex", "amp"]) {
      const goldenCase = fixture(agent).cases[0];
      const event = assertCaptured(agent, JSON.stringify(goldenCase.native));
      assert.equal(event.event, "pre_tool");
      assert.equal(event.tool, "Bash");
      assert.deepEqual(event, goldenCase.event);
    }
  });

  it("parses gemini's BeforeTool payload to a pre_tool event (tool canonicalized to Bash)", () => {
    const native = fixture("gemini").cases[0].native;
    const event = assertCaptured("gemini", JSON.stringify(native));
    assert.equal(event.event, "pre_tool");
    assert.equal(event.tool, "Bash");
    assert.equal(event.meta.native_tool, "run_shell_command");
  });

  it("accepts a non-pre_tool payload without demanding a tool", () => {
    // claude's prompt_submit fixture: a known kind, tool null — must not trip
    // the pre_tool tool/input requirement.
    const prompt = fixture("claude").cases.find(
      (c) => c.event.event === "prompt_submit",
    );
    const event = assertCaptured("claude", JSON.stringify(prompt.native));
    assert.equal(event.event, "prompt_submit");
    assert.equal(event.tool, null);
  });

  it("fails loud on an empty capture (the hook never fired)", () => {
    assert.throws(() => assertCaptured("claude", ""), /empty capture/);
    assert.throws(() => assertCaptured("claude", "   "), /empty capture/);
  });

  it("throws on an unknown agent and on unparseable JSON", () => {
    assert.throws(() => assertCaptured("nope", "{}"), /unknown agent nope/);
    assert.throws(() => assertCaptured("claude", "not json {{{"));
  });
});
