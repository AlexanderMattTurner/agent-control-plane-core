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
 * can't be parsed or the render throws, return `onFailure` — the host's OWN
 * fail-safe response from {@link failurePosture} — so a crashed hook degrades
 * the way THAT host expects instead of a single shared default. This is the
 * deliberate, necessary recovery the whole per-host split exists for, not a
 * blanket swallow.
 *
 * A judge that THROWS is not a malformed payload: the call parsed, and the judge
 * failed to answer. That takes the same path as a judge that answers garbage —
 * the clamp's `ask` (see below) — so a crashing guardrail puts the call in front
 * of a human instead of taking an exit-0 fail-safe that runs it. The verdict
 * renders through `renderEscalated`, so on a host with no ask tier that ask
 * blocks a vetoable call rather than running it.
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
export function renderHookResponse(adapter: import("./control-plane.mjs").Adapter, rawInput: string, onFailure: import("./control-plane.mjs").NativeResponse, judge?: (event: import("./control-plane.mjs").ToolCallEvent) => import("./control-plane.mjs").Verdict): import("./control-plane.mjs").NativeResponse;
/**
 * The response that BLOCKS the call on `agent`'s host: its
 * {@link BLOCK_TRANSPORT} row's exit code, with `reason` on the row's reason
 * stream. Every row blocks, so this is the one fail-closed response for all hosts.
 * @param {string} agent
 * @param {string} reason
 * @returns {import("./control-plane.mjs").NativeResponse}
 */
export function failClosedResponse(agent: string, reason: string): import("./control-plane.mjs").NativeResponse;
/**
 * The failure response for `agent`: its {@link HOST_FAILURE} row, or
 * {@link failClosedResponse} when `ACP_FAIL_CLOSED=1`. A blocking failure
 * response also blocks a call whose judge threw or answered no decision.
 * Register a fail-closed entry on tool-call events only: on a Stop event,
 * exit 2 means "keep working". {@link runHookEntry} also answers a hang
 * before the host's timeout. It cannot answer for a process that never starts
 * or that the host kills for another reason; only the host can, as Claude
 * Code's `"onFailure": "block"` does.
 * @param {string} agent
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("./control-plane.mjs").NativeResponse}
 */
export function failurePosture(agent: string, env?: NodeJS.ProcessEnv): import("./control-plane.mjs").NativeResponse;
/**
 * The whole hook entry for `adapter`'s host: read stdin, run
 * {@link renderHookResponse} with that host's {@link failurePosture}, and
 * {@link emit} the result. Every `bin/<host>-hook.mjs` is this one call. The
 * failure response also answers a stdin read error and, when
 * {@link hookDeadlineMs} is set, a hook still running at that deadline.
 * @param {import("./control-plane.mjs").Adapter} adapter
 * @param {(event: import("./control-plane.mjs").ToolCallEvent) => import("./control-plane.mjs").Verdict} [judge]
 * @returns {Promise<never>}
 */
export function runHookEntry(adapter: import("./control-plane.mjs").Adapter, judge?: (event: import("./control-plane.mjs").ToolCallEvent) => import("./control-plane.mjs").Verdict): Promise<never>;
/**
 * `ACP_HOOK_TIMEOUT_MS` as a positive integer, or `undefined` when unset. Set it
 * below the host's own hook timeout, so the hook's failure response lands
 * before the host kills it.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number|undefined}
 */
export function hookDeadlineMs(env?: NodeJS.ProcessEnv): number | undefined;
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
export const HOST_FAILURE: Readonly<Record<string, import("./control-plane.mjs").NativeResponse>>;
