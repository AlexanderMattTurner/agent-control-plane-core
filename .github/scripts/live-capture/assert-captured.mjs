// Assert that a REAL native payload captured from a live agent still parses to a
// well-formed ToolCallEvent through that agent's adapter — the crux of Tier-2
// live conformance ("assert real emissions"). This is the deterministic,
// credential-free half of the capture flow: given the bytes the agent emitted,
// the adapter must recognize them. It runs on whatever capture.mjs recorded, and
// is unit-tested directly against the golden fixtures' native payloads.

import { readFileSync, realpathSync } from "node:fs";
import { EventKind } from "../../../src/control-plane.mjs";
import { claudeAdapter } from "../../../src/adapters/claude.mjs";
import { codexAdapter } from "../../../src/adapters/codex.mjs";
import { ampAdapter } from "../../../src/adapters/amp.mjs";
import { geminiAdapter } from "../../../src/adapters/gemini.mjs";

const ADAPTERS = {
  claude: claudeAdapter,
  codex: codexAdapter,
  amp: ampAdapter,
  gemini: geminiAdapter,
};

const KNOWN_KINDS = new Set(Object.values(EventKind));

/**
 * Parse a captured native payload through the agent's adapter and assert it is a
 * well-formed event. Throws (fail loud) on: an unknown agent, an empty capture
 * (the hook never fired), unparseable JSON, an unrecognized event kind, or a
 * pre_tool event missing its tool/input. Returns the parsed {@link ToolCallEvent}.
 * @param {string} agent
 * @param {string} rawPayload
 * @returns {import("../../../src/control-plane.mjs").ToolCallEvent}
 */
export function assertCaptured(agent, rawPayload) {
  const adapter = ADAPTERS[agent];
  if (!adapter) throw new Error(`live-capture: unknown agent ${agent}`);
  if (typeof rawPayload !== "string" || rawPayload.trim() === "")
    throw new Error(
      `live-capture: empty capture for ${agent} — the hook never fired (no tool call, or the hook config is wrong)`,
    );

  const native = JSON.parse(rawPayload);
  const event = adapter.parse(native);

  if (!KNOWN_KINDS.has(event.event))
    throw new Error(
      `live-capture: ${agent} payload parsed to unrecognized event kind ${JSON.stringify(event.event)}`,
    );
  if (
    event.event === EventKind.PRE_TOOL &&
    (event.tool === null ||
      typeof event.input !== "object" ||
      event.input === null)
  )
    throw new Error(
      `live-capture: ${agent} pre_tool event is missing tool or input — the payload shape drifted`,
    );

  return event;
}

// CLI entry: `node assert-captured.mjs <agent> <capture-file>`.
const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked === realpathSync(new URL(import.meta.url).pathname)) {
  const [, , agent, file] = process.argv;
  if (!agent || !file) {
    process.stderr.write("usage: assert-captured.mjs <agent> <capture-file>\n");
    process.exit(2);
  }
  const event = assertCaptured(agent, readFileSync(file, "utf8"));
  process.stdout.write(
    `${agent}: captured payload parses to ${event.event}` +
      (event.tool ? ` (${event.tool})` : "") +
      `\n${JSON.stringify(event, null, 2)}\n`,
  );
}
