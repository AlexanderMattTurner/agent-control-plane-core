/**
 * Child process for the `emit` short-write regression test: render a deny whose
 * body is far larger than a pipe buffer and emit it, with fd 1 in the
 * NON-BLOCKING state a real host run reaches (see below).
 *
 * `--pad=<bytes>` is the byte length of the padding inside the deny reason.
 */
import { readFlag } from "../../.github/scripts/lib/cli-args.mjs";
import { claudeAdapter } from "../../src/adapters/claude.mjs";
import { emit } from "../../bin/hook-runtime.mjs";

const rawPad = readFlag(process.argv, "pad");
const padBytes = Number(rawPad);
if (!Number.isInteger(padBytes) || padBytes <= 0)
  throw new Error(`fixture needs --pad=<positive integer>, got ${rawPad}`);

const event = claudeAdapter.parse({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /" },
});
const response = claudeAdapter.render(
  { decision: "deny", reason: "x".repeat(padBytes) },
  event,
);

// Touching `process.stdout` makes libuv open fd 1 as a uv_pipe and set
// O_NONBLOCK on it — the state any `console.log` from a judge, or Node itself,
// leaves behind. It is what turns a single `writeSync` into a short write, so
// the regression is only observable with it. The empty write adds no bytes.
process.stdout.write("");

emit(response);
