// Tier-2 live-conformance orchestrator: capture and verify one agent's REAL
// pre-tool payload. Run per agent by .github/workflows/live-conformance.yaml.
//
//   node capture.mjs <agent>
//
// Flow: read the SSOT for the agent → skip cleanly if its provider secret is
// absent → install the pinned CLI → register dump.mjs as the pre-tool hook
// (write-hook-config.mjs) → run the CLI non-interactively with a canned "run
// echo" prompt, retrying because a model turn may not call the tool first try →
// assert the captured payload still parses (assert-captured.mjs).
//
// The installs/spawns and the exact run invocations below are research-derived
// and NOT verified against a live CLI in this repo (that needs the provider
// secrets). They are the maintainer's starting point for a manual dispatch —
// expect to iterate on flags per pinned version. The two DETERMINISTIC halves
// (config generation, payload assertion) are unit-tested in test/live-capture.test.mjs.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeHookConfig } from "./write-hook-config.mjs";
import { assertCaptured } from "./assert-captured.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const DUMP = join(HERE, "dump.mjs");
const MAX_ATTEMPTS = 5;
const CANNED_PROMPT =
  "Run this exact shell command and nothing else: echo acp-live-capture";

// Per-agent non-interactive run invocation. UNVERIFIED — the flags that force a
// tool call without an interactive approval prompt are version-specific; confirm
// on a live dispatch.
const RUN_ARGV = {
  claude: ["claude", "-p", "--dangerously-skip-permissions", CANNED_PROMPT],
  codex: [
    "codex",
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    CANNED_PROMPT,
  ],
  amp: ["amp", "-x", CANNED_PROMPT],
  gemini: ["gemini", "--yolo", "-p", CANNED_PROMPT],
};

/** @param {string} m */
function fail(m) {
  process.stderr.write(`live-capture: ${m}\n`);
  process.exit(1);
}

function readSsot() {
  const raw = readFileSync(
    join(REPO_ROOT, "config", "live-conformance.json"),
    "utf8",
  );
  return JSON.parse(raw).adapters;
}

/** @param {string} label @param {string} cmd @param {string[]} args @param {object} opts */
function run(label, cmd, args, opts) {
  process.stdout.write(`live-capture: ${label}: ${cmd} ${args.join(" ")}\n`);
  return spawnSync(cmd, args, { stdio: "inherit", ...opts });
}

/** @param {string} file */
function captured(file) {
  return existsSync(file) && statSync(file).size > 0;
}

const agent = process.argv[2];
if (!agent) fail("usage: capture.mjs <agent>");

const entry = readSsot().find((a) => a.agent === agent);
if (!entry) fail(`no SSOT entry for agent ${agent}`);
if (!RUN_ARGV[agent]) fail(`no run invocation defined for agent ${agent}`);

// codex speaks the OpenAI protocol, so it can run against any OpenAI-compatible
// backend — direct OpenAI, or OpenRouter/Venice via a model_providers block. The
// first backend whose secret is present wins; base_urls/models are UNVERIFIED
// defaults (override the model with $CODEX_MODEL).
const CODEX_BACKENDS = [
  { envKey: "OPENAI_API_KEY" },
  {
    envKey: "OPENROUTER_API_KEY",
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
  },
  {
    envKey: "VENICE_INFERENCE_KEY",
    name: "venice",
    baseUrl: "https://api.venice.ai/api/v1",
    model: "llama-3.3-70b",
  },
];

/** @type {{ name: string, baseUrl: string, envKey: string, model: string }|undefined} */
let provider;
if (agent === "codex") {
  const backend = CODEX_BACKENDS.find((b) => process.env[b.envKey]);
  if (!backend) {
    process.stdout.write(
      `::notice::live-capture codex skipped — none of ${CODEX_BACKENDS.map((b) => b.envKey).join(", ")} set\n`,
    );
    process.exit(0);
  }
  if (backend.name)
    provider = {
      name: backend.name,
      baseUrl: backend.baseUrl,
      envKey: backend.envKey,
      model: process.env.CODEX_MODEL || backend.model,
    };
} else if (!process.env[entry.secret]) {
  process.stdout.write(
    `::notice::live-capture ${agent} skipped — ${entry.secret} not set\n`,
  );
  process.exit(0);
}

// Install the pinned CLI (rolling releases have no pin → latest).
const version =
  entry.versioning === "rolling" ? "latest" : entry.captured_version;
const install = run("install", "npm", [
  "i",
  "-g",
  `${entry.package}@${version}`,
]);
if (install.status !== 0) fail(`install of ${entry.package}@${version} failed`);

const baseDir = mkdtempSync(join(tmpdir(), `acp-live-${agent}-`));
const captureFile = join(baseDir, "capture.json");
const { env: cfgEnv } = writeHookConfig(agent, baseDir, {
  dumpCommand: `node ${DUMP}`,
  matcher: entry.tool_matcher,
  provider,
});
if (provider)
  process.stdout.write(
    `live-capture: codex backend = ${provider.name} (${provider.baseUrl}, model ${provider.model})\n`,
  );

const runEnv = { ...process.env, ...cfgEnv, ACP_CAPTURE_FILE: captureFile };
const [cmd, ...args] = RUN_ARGV[agent];

for (
  let attempt = 1;
  attempt <= MAX_ATTEMPTS && !captured(captureFile);
  attempt++
) {
  run(`attempt ${attempt}/${MAX_ATTEMPTS}`, cmd, args, {
    cwd: baseDir,
    env: runEnv,
  });
}

if (!captured(captureFile))
  fail(
    `${agent}: no payload captured after ${MAX_ATTEMPTS} attempts — the model may not have called the shell tool, or the hook config needs adjusting for this CLI version`,
  );

const event = assertCaptured(agent, readFileSync(captureFile, "utf8"));
process.stdout.write(
  `live-capture: ${agent} OK — real payload parses to ${event.event}` +
    (event.tool ? ` (${event.tool})` : "") +
    "\n",
);
