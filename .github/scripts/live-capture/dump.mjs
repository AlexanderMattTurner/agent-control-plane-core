// The capture "hook command" a real agent CLI invokes on a pre-tool event during
// Tier-2 live conformance. It writes the raw native payload the agent put on
// stdin to the target file, then exits 0 (allow) so the agent proceeds normally
// — the point is to record the payload the agent actually emits, not to gate
// the call.
//
// Registered as the command hook by write-hook-config.mjs. Node (not shell) so
// it stays lint-clean and portable, and so a missing capture path fails loud
// rather than silently writing nowhere.
//
// The target path rides on the command line as the named --capture-file=<path>
// flag, not an env var: the first live dispatch against Gemini CLI showed
// "ACP_CAPTURE_FILE is not set" even though the parent gemini process had it —
// the host sandboxes the env a hook subprocess inherits, so passing state
// through env is not portable across hosts. A NAMED flag (searched by prefix,
// not a bare positional index) means an unrelated argument prepended to the
// command line by us or by a host can never silently shift which value this
// script reads as its target. The env var is kept as a fallback for
// direct/manual invocation only.

import { writeFileSync, readFileSync } from "node:fs";
import { readFlag } from "../lib/cli-args.mjs";

const target =
  readFlag(process.argv, "capture-file") || process.env.ACP_CAPTURE_FILE;
if (!target) {
  process.stderr.write(
    "dump.mjs: no capture target — pass --capture-file=<path> or set ACP_CAPTURE_FILE\n",
  );
  process.exit(1);
}

// Read all of stdin (fd 0) synchronously — the agent has already written the
// payload and closed the pipe by the time the hook runs.
let payload = "";
try {
  payload = readFileSync(0, "utf8");
} catch {
  payload = "";
}
writeFileSync(target, payload);
process.exit(0);
