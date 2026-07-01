#!/usr/bin/env node
/**
 * Minimal runnable EXTERNAL_HOOK entry — proves the transport end-to-end.
 *
 * Reads a native hook payload on stdin, normalizes it with the chosen agent's
 * adapter, applies a DEMO policy (deny any command matching /rm -rf/), and emits
 * the agent's native response: writes the stdout body when the transport has one
 * and exits with the transport's exit code. This is the exact shape a real hook
 * binary takes; the demo policy stands in for the guardrail's real judge(), and
 * integration.test.mjs drives it as a subprocess to prove exit codes / stdout
 * actually reach the agent.
 *
 * Usage: `node bin/agent-hook.mjs --agent claude < payload.json`
 */
import { claudeAdapter } from "../src/adapters/claude.mjs";
import { codexAdapter } from "../src/adapters/codex.mjs";
import { ampAdapter } from "../src/adapters/amp.mjs";

const ADAPTERS = {
  claude: claudeAdapter,
  codex: codexAdapter,
  amp: ampAdapter,
};

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString()));
    process.stdin.on("error", reject);
  });
}

const agent = process.argv[process.argv.indexOf("--agent") + 1];
const adapter = ADAPTERS[agent];
if (!adapter) {
  process.stderr.write(`unknown or missing --agent (got: ${agent})\n`);
  process.exit(64);
}

const event = adapter.parse(JSON.parse(await readStdin()));
const command =
  typeof event.input.command === "string" ? event.input.command : "";
const verdict = /rm\s+-rf/.test(command)
  ? { decision: "deny", reason: "demo policy: rm -rf blocked" }
  : { decision: "allow" };

const response = adapter.render(verdict, event);
if (response.stdout !== undefined)
  process.stdout.write(JSON.stringify(response.stdout));
process.exit(response.exit_code);
