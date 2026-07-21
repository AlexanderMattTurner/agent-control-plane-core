/**
 * Shared plumbing for the per-host EXTERNAL_HOOK entries — NOT a runtime host
 * multiplexer. Each host has its OWN entry (`bin/<host>-hook.mjs`) that hardcodes
 * its adapter and declares its OWN failure posture; this module only holds the
 * transport mechanics they genuinely share (stdin read, the demo judge, the
 * parse→judge→render pipe with a host-supplied fail-safe, and stdout+exit
 * emission). The thing item ② deleted was the `--agent` switch that let one
 * binary impersonate every host and so had to pick a single shared failure
 * behavior; sharing pure plumbing across distinct entries is not that.
 */
import { Decision } from "../src/control-plane.mjs";

/** Read all of stdin to a string. */
export function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString()));
    process.stdin.on("error", reject);
  });
}

/**
 * The DEMO policy standing in for a real guardrail judge: deny any command
 * matching /rm -rf/, allow everything else. A real deployment swaps this for its
 * own judge over the normalized {@link ToolCallEvent}.
 * @param {import("../src/control-plane.mjs").ToolCallEvent} event
 * @returns {import("../src/control-plane.mjs").Verdict}
 */
export function demoJudge(event) {
  const command =
    typeof event.input.command === "string" ? event.input.command : "";
  return /rm\s+-rf/.test(command)
    ? { decision: Decision.DENY, reason: "demo policy: rm -rf blocked" }
    : { decision: Decision.ALLOW };
}

/**
 * Run one host's parse→judge→render pipe over a raw stdin payload. If the payload
 * can't be parsed or the pipe throws, return `onFailure` — the host's OWN
 * fail-safe response — so a crashed hook degrades the way THAT host expects
 * (claude/codex fail OPEN = exit 0; amp fails to ASK = exit 1) instead of a
 * single shared default. This is the deliberate, necessary recovery the whole
 * per-host split exists for, not a blanket swallow.
 *
 * Before returning the fail-safe, the error is written to STDERR (never stdout,
 * which belongs to the host transport) so a regression that silently disables
 * enforcement leaves a greppable trace. Every host tolerates hook stderr:
 * claude/codex surface it only in verbose/debug on a 0 exit, amp forwards the
 * helper's stderr, and gemini reads stderr as a reason only on exit 2 — none of
 * these fail-safe exits is a 2 for a stdout-carrying transport, and amp's ask
 * (exit 1) shows the diagnostic alongside the prompt, which is the point.
 * @param {import("../src/control-plane.mjs").Adapter} adapter
 * @param {string} rawInput
 * @param {import("../src/control-plane.mjs").NativeResponse} onFailure
 * @returns {import("../src/control-plane.mjs").NativeResponse}
 */
export function renderHookResponse(adapter, rawInput, onFailure) {
  try {
    const event = adapter.parse(JSON.parse(rawInput));
    return adapter.render(demoJudge(event), event);
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : `${err}`;
    process.stderr.write(`[acp] hook pipeline error: ${detail}\n`);
    return onFailure;
  }
}

/**
 * Emit a {@link NativeResponse} to the host: write the native stdout body when
 * the transport has one, then exit with the transport's exit code.
 * @param {import("../src/control-plane.mjs").NativeResponse} response
 * @returns {never}
 */
export function emit(response) {
  if (response.stdout !== undefined)
    process.stdout.write(JSON.stringify(response.stdout));
  process.exit(response.exit_code);
}
