// Assert that a REAL native payload captured from a live agent still parses to a
// well-formed ToolCallEvent through that agent's adapter — the crux of Tier-2
// live conformance ("assert real emissions"). This is the deterministic,
// credential-free half of the capture flow: given the bytes the agent emitted,
// the adapter must recognize them. It runs on whatever capture.mjs recorded, and
// is unit-tested directly against the golden fixtures' native payloads.

import { readFileSync } from "node:fs";
import { EventKind } from "../../../src/control-plane.mjs";
import { adapterFor, LAUNCHER_OPTIONS } from "../../../src/registry.mjs";
import { isMainModule, readFlag } from "../lib/cli-args.mjs";

/**
 * The live-conformance SSOT's adapter entries (`config/live-conformance.json`):
 * which CLI version each agent's fixtures were captured against.
 * @returns {Array<Record<string, string>>}
 */
export function liveConformanceEntries() {
  return JSON.parse(
    readFileSync(
      new URL("../../../config/live-conformance.json", import.meta.url),
      "utf8",
    ),
  ).adapters;
}

/**
 * Each launcher option's value, read from an agent's SSOT entry. Keyed by
 * option name, not agent: `LAUNCHER_OPTIONS` says which agents read which.
 * @type {Record<string, (entry: Record<string, string>) => unknown>}
 */
const OPTION_FROM_ENTRY = {
  version: (entry) => entry.captured_version,
};

/**
 * The adapter for `agent` as the live capture launched it: each launcher
 * option its adapter reads (Codex's version) set from its SSOT entry, every
 * other agent as shipped. The golden fixtures are captured payloads, so the
 * conformance suites parse them through this too.
 * @param {string} agent
 * @returns {import("../../../src/control-plane.mjs").Adapter}
 */
export function capturedAdapter(agent) {
  const names = LAUNCHER_OPTIONS[agent] ?? [];
  if (names.length === 0) return adapterFor(agent);
  const entry = liveConformanceEntries().find((a) => a.agent === agent);
  if (entry === undefined)
    throw new Error(
      `live-capture: config/live-conformance.json has no entry for ${agent}`,
    );
  return adapterFor(
    agent,
    Object.fromEntries(
      names.map((name) => {
        const read = OPTION_FROM_ENTRY[name];
        if (read === undefined)
          throw new Error(
            `live-capture: no SSOT field for ${agent}'s launcher option ${JSON.stringify(name)}`,
          );
        return [name, read(entry)];
      }),
    ),
  );
}

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
  const adapter = capturedAdapter(agent);
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

// CLI entry: `node assert-captured.mjs --agent=<agent> --capture-file=<path>`.
if (isMainModule(import.meta.url)) {
  const agent = readFlag(process.argv, "agent");
  const file = readFlag(process.argv, "capture-file");
  if (!agent || !file) {
    process.stderr.write(
      "usage: assert-captured.mjs --agent=<agent> --capture-file=<path>\n",
    );
    process.exit(2);
  }
  const event = assertCaptured(agent, readFileSync(file, "utf8"));
  process.stdout.write(
    `${agent}: captured payload parses to ${event.event}` +
      (event.tool ? ` (${event.tool})` : "") +
      `\n${JSON.stringify(event, null, 2)}\n`,
  );
}
