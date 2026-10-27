/**
 * The EXTERNAL_HOOK runtime, published at `agent-control-plane-core/runtime` —
 * NOT a runtime host multiplexer. Each host has its OWN entry
 * (`bin/<host>-hook.mjs`) that hardcodes its adapter; {@link runHookEntry}
 * runs it with that host's OWN failure posture from {@link HOST_FAILURE}. The
 * thing item ② deleted was the `--agent` switch that let one binary
 * impersonate every host and so had to pick a single shared failure behavior;
 * a per-host table keyed by the adapter's own AGENT is not that.
 *
 * It is exported because every consumer writing its own hook entry had to
 * re-implement the same two things, and both fail silently when they are wrong:
 * draining stdin before parsing, and flushing the response IN FULL before
 * `process.exit` (see {@link writeAllSync}).
 */
import { writeSync } from "node:fs";
import { Decision, gatedResponse, sanitizeVerdict } from "./control-plane.mjs";

/**
 * Read all of stdin to a string.
 * @returns {Promise<string>}
 */
export function readStdin() {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    // A consumer that set an encoding on stdin hands STRINGS to this listener, and
    // Buffer.concat throws on one. That throw escapes from the stream's callback,
    // not from this promise, so it never reaches the caller's fail-safe: the hook
    // dies with no response and a fail-open host runs the unjudged call.
    process.stdin.on("data", (chunk) =>
      chunks.push(
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
      ),
    );
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString()));
    process.stdin.on("error", reject);
  });
}

/**
 * The DEMO policy standing in for a real guardrail judge: deny any command
 * matching /rm -rf/, allow everything else. A real deployment swaps this for its
 * own judge over the normalized {@link ToolCallEvent}.
 * @param {import("./control-plane.mjs").ToolCallEvent} event
 * @returns {import("./control-plane.mjs").Verdict}
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
 * can't be parsed or the render throws, return `onFailure` — the host's OWN
 * fail-safe response from {@link failurePosture} — so a crashed hook degrades
 * the way THAT host expects instead of a single shared default. This is the
 * deliberate, necessary recovery the whole per-host split exists for, not a
 * blanket swallow.
 *
 * A judge that THROWS is not a malformed payload: the call parsed, and the judge
 * failed to answer. That takes the same path as a judge that answers garbage —
 * the clamp's `ask` (see below) — so a crashing guardrail puts the call in front
 * of a human instead of taking an exit-0 fail-safe that runs it.
 *
 * Every error is written to STDERR (never stdout, which belongs to the host
 * transport) so a regression that silently disables enforcement leaves a
 * greppable trace. Every host tolerates hook stderr: claude/codex surface it
 * only in verbose/debug on a 0 exit, amp forwards the helper's stderr, and
 * gemini reads stderr as a reason only on exit 2.
 * `judge` is the seam a real deployment fills — {@link demoJudge} is a stand-in,
 * so the guardrail is supplied here rather than by forking this file. Whatever
 * it returns is treated as untrusted (see the clamp below).
 * @param {import("./control-plane.mjs").Adapter} adapter
 * @param {string} rawInput
 * @param {import("./control-plane.mjs").NativeResponse} onFailure
 * @param {(event: import("./control-plane.mjs").ToolCallEvent) => import("./control-plane.mjs").Verdict} [judge]
 * @returns {import("./control-plane.mjs").NativeResponse}
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
    /** @type {unknown} */
    let answer;
    try {
      answer = judge(event);
    } catch (err) {
      // No `decision`, so the clamp below turns this into an `ask`.
      answer = { reason: `hook judge threw: ${describe(err).split("\n")[0]}` };
      report("hook judge error", err);
    }
    // A host-supplied `onFailure` that BLOCKS (see {@link failurePosture}) wins
    // over the clamp's ask: Codex and Gemini cannot enforce an ask, so the
    // clamp would run a call no judge approved.
    if (onFailure.enforced && !isDecision(answer)) return onFailure;
    // A judge's answer is clamped, not trusted. `normalizeVerdict` (inside
    // every adapter's render) THROWS on a decision outside allow/deny/ask, and
    // that throw would land in the catch below — the host's fail-safe, exit 0
    // on claude/codex/gemini. So a judge that means DENY but spells it "denied"
    // would let the tool run. Clamping to "ask" first keeps a malformed answer
    // in front of a human. Prose is passed through: scrubbing monitor-authored
    // text needs a scrubber this transport module has no business choosing.
    const verdict = sanitizeVerdict(answer, (text) => text);
    return adapter.render(verdict, event);
  } catch (err) {
    report("hook pipeline error", err);
    return onFailure;
  }
}

/**
 * Whether `answer` carries one of the three decisions a judge may return.
 * @param {unknown} answer
 * @returns {boolean}
 */
function isDecision(answer) {
  const decision =
    answer !== null && typeof answer === "object"
      ? /** @type {{ decision?: unknown }} */ (answer).decision
      : undefined;
  return Object.values(Decision).includes(/** @type {any} */ (decision));
}

/**
 * The response that BLOCKS the call on `agent`'s host: its
 * {@link BLOCK_TRANSPORT} row's exit code, with `reason` on the row's reason
 * stream. Every row blocks, so this is the one fail-closed response for all hosts.
 * @param {string} agent
 * @param {string} reason
 * @returns {import("./control-plane.mjs").NativeResponse}
 */
export function failClosedResponse(agent, reason) {
  return gatedResponse(agent, {
    transport: "external_hook",
    enforced: true,
    unblocked_exit_code: 0,
    reason,
  });
}

/** @type {import("./control-plane.mjs").NativeResponse} */
const RUN = Object.freeze({
  transport: "external_hook",
  exit_code: 0,
  enforced: false,
});

/**
 * Each host's DEFAULT response when its hook breaks, which is how that host
 * degrades a hook it cannot read:
 * - claude, codex, gemini: exit 0, so the call runs. Each host treats a crashed
 *   or non-conforming hook as no objection, and a spurious block would wedge the
 *   user. The sandbox is the backstop.
 * - amp: exit 1, which Amp's delegate reads as "ask the human". That neither
 *   runs nor rejects a call no judge saw.
 * @type {Readonly<Record<string, import("./control-plane.mjs").NativeResponse>>}
 */
export const HOST_FAILURE = Object.freeze({
  claude: RUN,
  codex: RUN,
  gemini: RUN,
  amp: Object.freeze({
    transport: "external_hook",
    exit_code: 1,
    enforced: false,
  }),
});

/**
 * The failure response for `agent`: its {@link HOST_FAILURE} row, or
 * {@link failClosedResponse} when `ACP_FAIL_CLOSED=1`. A blocking failure
 * response also blocks a call whose judge threw or answered no decision.
 * Register a fail-closed entry on tool-call events only: on a Stop event,
 * exit 2 means "keep working". This cannot cover a hook the host kills, times
 * out or fails to start; only the host can, as Claude Code's
 * `"onFailure": "block"` does.
 * @param {string} agent
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("./control-plane.mjs").NativeResponse}
 */
export function failurePosture(agent, env = process.env) {
  if (!Object.hasOwn(HOST_FAILURE, agent))
    throw new Error(
      `runtime: no HOST_FAILURE row for agent ${JSON.stringify(agent)}`,
    );
  const flag = env.ACP_FAIL_CLOSED;
  if (flag === undefined || flag === "" || flag === "0")
    return HOST_FAILURE[agent];
  if (flag !== "1")
    throw new Error(
      `ACP_FAIL_CLOSED must be "1" or "0", got ${JSON.stringify(flag)}`,
    );
  return failClosedResponse(
    agent,
    "hook failed; ACP_FAIL_CLOSED blocks the call",
  );
}

/**
 * The whole hook entry for `adapter`'s host: read stdin, run
 * {@link renderHookResponse} with that host's {@link failurePosture}, and
 * {@link emit} the result. Every `bin/<host>-hook.mjs` is this one call.
 * @param {import("./control-plane.mjs").Adapter} adapter
 * @param {(event: import("./control-plane.mjs").ToolCallEvent) => import("./control-plane.mjs").Verdict} [judge]
 * @returns {Promise<never>}
 */
export async function runHookEntry(adapter, judge = demoJudge) {
  const onFailure = failurePosture(adapter.AGENT);
  return emit(renderHookResponse(adapter, await readStdin(), onFailure, judge));
}

/**
 * A thrown value as readable text: an Error's stack (or message when it has no
 * stack), or the value itself for a bare throw.
 * @param {unknown} err
 * @returns {string}
 */
function describe(err) {
  return err instanceof Error ? (err.stack ?? err.message) : `${err}`;
}

/**
 * Write one diagnostic line for `err` to stderr.
 * @param {string} label
 * @param {unknown} err
 */
function report(label, err) {
  process.stderr.write(`[acp] ${label}: ${describe(err)}\n`);
}

/**
 * A one-millisecond synchronous sleep buffer for the EAGAIN retry in
 * {@link writeAllSync}. Allocated once at module scope: the retry path must not
 * allocate per iteration while it is draining a full pipe.
 */
const RETRY_SLEEP = new Int32Array(new SharedArrayBuffer(4));

/**
 * Whether a failed `writeSync` is the one recoverable case: EAGAIN, meaning the
 * non-blocking pipe is momentarily full because the host has not drained it
 * yet. The caller sleeps 1ms and retries — the same wait a blocking write would
 * have done in the kernel. Every other errno (EPIPE, EBADF, ...) propagates.
 *
 * A non-Error throw is NOT retryable, and is checked separately rather than
 * left to the `code` comparison: a plain object carrying `code: "EAGAIN"` is
 * not a write that the kernel asked us to repeat, and retrying one forever is a
 * hang rather than a short write. Exported so a test can drive every branch —
 * the real `writeSync` only ever throws an Error.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryableWriteError(err) {
  return err instanceof Error && /** @type {any} */ (err).code === "EAGAIN";
}

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
 *
 * Exported so a test can drive the propagation path against a real closed
 * descriptor; {@link emit} is the only caller a consumer needs.
 * @param {number} fd
 * @param {string} text
 */
export function writeAllSync(fd, text) {
  const buf = Buffer.from(text, "utf8");
  let written = 0;
  while (written < buf.length) {
    try {
      written += writeSync(fd, buf, written);
    } catch (err) {
      // There is deliberately no retry cap: a cap would reintroduce exactly the
      // silent truncation this loop exists to kill, and a host that never reads
      // would have blocked us forever anyway.
      if (!isRetryableWriteError(err)) throw err;
      Atomics.wait(RETRY_SLEEP, 0, 0, 1);
    }
  }
}

/**
 * Emit a {@link NativeResponse} to the host: write the native stdout body when
 * the transport has one, then exit with the transport's exit code.
 * @param {import("./control-plane.mjs").NativeResponse} response
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
