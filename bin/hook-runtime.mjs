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
import { writeSync } from "node:fs";
import { Decision, sanitizeVerdict } from "../src/control-plane.mjs";

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
 * `judge` is the seam a real deployment fills — {@link demoJudge} is a stand-in,
 * so the guardrail is supplied here rather than by forking this file. Whatever
 * it returns is treated as untrusted (see the clamp below).
 * @param {import("../src/control-plane.mjs").Adapter} adapter
 * @param {string} rawInput
 * @param {import("../src/control-plane.mjs").NativeResponse} onFailure
 * @param {(event: import("../src/control-plane.mjs").ToolCallEvent) => import("../src/control-plane.mjs").Verdict} [judge]
 * @returns {import("../src/control-plane.mjs").NativeResponse}
 */
export function renderHookResponse(
  adapter,
  rawInput,
  onFailure,
  judge = demoJudge,
) {
  try {
    const native = JSON.parse(rawInput);
    // A non-object top-level payload (null, array, number, string) is malformed:
    // the adapters' `asObject` would silently coerce it to `{}` and judge it as a
    // benign no-op tool call — a rubber-stamp with no trace. Throw so it takes the
    // host's declared failure posture AND leaves a greppable stderr diagnostic,
    // instead of a silent coerce-to-empty.
    if (native === null || typeof native !== "object" || Array.isArray(native))
      throw new TypeError(
        `hook payload must be a JSON object, got ${native === null ? "null" : Array.isArray(native) ? "array" : typeof native}`,
      );
    const event = adapter.parse(native);
    // A judge's answer is clamped, not trusted. `normalizeVerdict` (inside
    // every adapter's render) THROWS on a decision outside allow/deny/ask, and
    // that throw lands in the catch below — which returns the host's fail-safe,
    // exit 0 on claude/codex/gemini. So a judge that means DENY but spells it
    // "denied" would let the tool run. Clamping to "ask" first keeps a
    // malformed answer in front of a human. Prose is passed through: scrubbing
    // monitor-authored text needs a scrubber this transport module has no
    // business choosing, and the decision is the half that gates the call.
    const verdict = sanitizeVerdict(judge(event), (text) => text);
    return adapter.render(verdict, event);
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : `${err}`;
    process.stderr.write(`[acp] hook pipeline error: ${detail}\n`);
    return onFailure;
  }
}

/**
 * A one-millisecond synchronous sleep buffer for the EAGAIN retry in
 * {@link writeAllSync}. Allocated once at module scope: the retry path must not
 * allocate per iteration while it is draining a full pipe.
 */
const RETRY_SLEEP = new Int32Array(new SharedArrayBuffer(4));

/**
 * Write `text` to `fd` IN FULL, looping until every byte lands.
 *
 * A single `writeSync` is not enough. When the host captures the hook, fd 1/2 is
 * a pipe, and libuv puts that pipe in NON-BLOCKING mode the moment anything
 * initializes `process.stdout`/`process.stderr` (a `console.log` in a judge, the
 * fail-safe stderr diagnostic in {@link renderHookResponse}). A non-blocking
 * `write(2)` returns a SHORT COUNT once the kernel pipe buffer fills — measured
 * at ~143 KiB here — so a deny body larger than that (a long `reason`, a big
 * `mutated_input`) was silently truncated and the process still exited 0/2 with
 * a half-written JSON the host cannot parse: an enforced deny degrading to a
 * run. Looping restores the blocking-write semantics the caller assumes.
 * @param {number} fd
 * @param {string} text
 */
function writeAllSync(fd, text) {
  const buf = Buffer.from(text, "utf8");
  let written = 0;
  while (written < buf.length) {
    try {
      written += writeSync(fd, buf, written);
    } catch (err) {
      // EAGAIN is the one recoverable case: the non-blocking pipe is momentarily
      // full because the host has not drained it yet. Sleep 1ms and retry — the
      // same wait a blocking write would have done in the kernel. Every other
      // errno (EPIPE, EBADF, ...) propagates. There is deliberately no retry cap:
      // a cap would reintroduce exactly the silent truncation this loop exists to
      // kill, and a host that never reads would have blocked us forever anyway.
      if (!(err instanceof Error) || /** @type {any} */ (err).code !== "EAGAIN")
        throw err;
      Atomics.wait(RETRY_SLEEP, 0, 0, 1);
    }
  }
}

/**
 * Emit a {@link NativeResponse} to the host: write the native stdout body when
 * the transport has one, then exit with the transport's exit code.
 * @param {import("../src/control-plane.mjs").NativeResponse} response
 * @returns {never}
 */
export function emit(response) {
  // `writeAllSync` (not `process.stdout.write`) so the body is flushed to fd 1
  // BEFORE `process.exit`. On a pipe — which stdout is when the host captures the
  // hook — `process.stdout.write` is asynchronous and `process.exit` does not
  // drain it, so an enforced-deny body (Claude/Codex `hookSpecificOutput`) could
  // be truncated; the host then reads a block-less exit and runs the tool. A
  // synchronous, fully-drained write closes that silent deny→allow window.
  if (response.stdout !== undefined)
    writeAllSync(1, JSON.stringify(response.stdout));
  // A host that reads the block reason from STDERR (Gemini's exit-2 System Block)
  // gets it here — written synchronously to fd 2 before exit, for the same
  // flush-before-exit reason as stdout above, so an enforced deny is never shown
  // with no rationale.
  if (response.stderr !== undefined) writeAllSync(2, response.stderr);
  process.exit(response.exit_code);
}
