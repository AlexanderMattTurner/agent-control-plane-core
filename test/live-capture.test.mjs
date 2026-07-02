import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  it("parses each agent's golden native payload to a well-formed event", () => {
    for (const agent of ["claude", "codex", "amp"]) {
      const native = fixture(agent).cases[0].native;
      const event = assertCaptured(agent, JSON.stringify(native));
      assert.equal(event.event, "pre_tool");
      assert.equal(event.tool, "Bash");
    }
  });

  it("parses gemini's BeforeTool payload to a pre_tool event", () => {
    const native = fixture("gemini").cases[0].native;
    const event = assertCaptured("gemini", JSON.stringify(native));
    assert.equal(event.event, "pre_tool");
    assert.equal(event.tool, "run_shell_command");
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
