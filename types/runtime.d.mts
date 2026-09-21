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
 * Emit a {@link NativeResponse} to the host: write the native stdout body when
 * the transport has one, then exit with the transport's exit code.
 * @param {import("./control-plane.mjs").NativeResponse} response
 * @returns {never}
 */
export function emit(response: import("./control-plane.mjs").NativeResponse): never;
