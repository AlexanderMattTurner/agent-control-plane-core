// Generate the per-agent hook/permission config that registers dump.mjs as the
// command a real agent CLI runs on a pre-tool event, so Tier-2 live conformance
// can capture the payload the agent actually emits. Pure config generation
// (buildHookConfig) is separated from disk I/O (writeHookConfig) so the shape is
// unit-testable without touching the filesystem.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Build the config file(s) that point an agent's pre-tool hook at `dumpCommand`,
 * matched to its shell tool. Returns file bodies (paths relative to a base dir)
 * plus any env the run needs (e.g. `CODEX_HOME`), whose values are relative and
 * resolved to absolute by {@link writeHookConfig}.
 * @param {string} agent
 * @param {{ dumpCommand: string, matcher: string, provider?: { name: string, baseUrl: string, envKey: string, model: string } }} opts
 * @returns {{ files: Array<{ rel: string, content: string }>, env: Record<string, string> }}
 */
export function buildHookConfig(agent, { dumpCommand, matcher, provider }) {
  if (agent === "claude") {
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher, hooks: [{ type: "command", command: dumpCommand }] },
        ],
      },
    };
    return {
      files: [{ rel: ".claude/settings.json", content: json(settings) }],
      env: {},
    };
  }
  if (agent === "codex") {
    // A `provider` routes codex at an OpenAI-compatible endpoint (OpenRouter,
    // Venice). TOML requires top-level keys (model_provider/model) BEFORE any
    // table header, then the hook tables, then the [model_providers.<name>]
    // table — so order matters here.
    const topLevel = provider
      ? `model_provider = ${JSON.stringify(provider.name)}\n` +
        `model = ${JSON.stringify(provider.model)}\n\n`
      : "";
    const hookBlock =
      `[[hooks.PreToolUse]]\n` +
      `matcher = ${JSON.stringify(matcher)}\n\n` +
      `[[hooks.PreToolUse.hooks]]\n` +
      `type = "command"\n` +
      `command = ${JSON.stringify(dumpCommand)}\n`;
    const providerTable = provider
      ? `\n[model_providers.${provider.name}]\n` +
        `name = ${JSON.stringify(provider.name)}\n` +
        `base_url = ${JSON.stringify(provider.baseUrl)}\n` +
        `env_key = ${JSON.stringify(provider.envKey)}\n`
      : "";
    return {
      files: [
        {
          rel: "codex-home/config.toml",
          content: topLevel + hookBlock + providerTable,
        },
      ],
      env: { CODEX_HOME: "codex-home" },
    };
  }
  if (agent === "gemini") {
    const settings = {
      hooks: {
        BeforeTool: [
          {
            matcher,
            hooks: [{ type: "command", command: dumpCommand, timeout: 60000 }],
          },
        ],
      },
    };
    return {
      files: [{ rel: ".gemini/settings.json", content: json(settings) }],
      env: {},
    };
  }
  if (agent === "amp") {
    // Best-effort, UNVERIFIED. Amp's delegate/permission path hands the tool
    // params to an external program on stdin and reads its EXIT CODE — which is
    // exactly dump.mjs's shape (write stdin, exit 0 = allow). The settings schema
    // itself is behind an auth-walled manual, so this is a starting point the
    // maintainer confirms on a live dispatch, not a verified config.
    const settings = {
      "amp.permissions": [
        { tool: matcher, action: "delegate", command: dumpCommand },
      ],
    };
    return {
      files: [{ rel: "amp-settings.json", content: json(settings) }],
      env: {},
    };
  }
  throw new Error(`live-capture: unknown agent ${agent}`);
}

/**
 * Write {@link buildHookConfig}'s output under `baseDir`, creating parent
 * directories, and resolve any relative env paths to absolute.
 * @param {string} agent
 * @param {string} baseDir
 * @param {{ dumpCommand: string, matcher: string }} opts
 * @returns {{ written: string[], env: Record<string, string> }}
 */
export function writeHookConfig(agent, baseDir, opts) {
  const cfg = buildHookConfig(agent, opts);
  const written = [];
  for (const f of cfg.files) {
    const abs = join(baseDir, f.rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
    written.push(abs);
  }
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(cfg.env)) env[k] = join(baseDir, v);
  return { written, env };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}
