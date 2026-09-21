/**
 * Read all of stdin to a string.
 * @returns {Promise<string>}
 */
export function readStdin(): Promise<string>;
/**
 * The DEMO policy standing in for a real guardrail judge: deny any command
 * matching /rm -rf/, allow everything else. A real deployment swaps this for its
 * own judge over the normalized {@link ToolCallEvent}.
 * @param {import("./control-plane.mjs").ToolCallEvent} event
 * @returns {import("./control-plane.mjs").Verdict}
 */
export function demoJudge(event: import("./control-plane.mjs").ToolCallEvent): import("./control-plane.mjs").Verdict;
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
 * @param {import("./control-plane.mjs").Adapter} adapter
 * @param {string} rawInput
 * @param {import("./control-plane.mjs").NativeResponse} onFailure
 * @param {(event: import("./control-plane.mjs").ToolCallEvent) => import("./control-plane.mjs").Verdict} [judge]
 * @returns {import("./control-plane.mjs").NativeResponse}
 */
export function renderHookResponse(adapter: import("./control-plane.mjs").Adapter, rawInput: string, onFailure: import("./control-plane.mjs").NativeResponse, judge?: (event: import("./control-plane.mjs").ToolCallEvent) => import("./control-plane.mjs").Verdict): import("./control-plane.mjs").NativeResponse;
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
export function isRetryableWriteError(err: unknown): boolean;
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
export function writeAllSync(fd: number, text: string): void;
/**
 * Emit a {@link NativeResponse} to the host: write the native stdout body when
 * the transport has one, then exit with the transport's exit code.
 * @param {import("./control-plane.mjs").NativeResponse} response
 * @returns {never}
 */
export function emit(response: import("./control-plane.mjs").NativeResponse): never;
