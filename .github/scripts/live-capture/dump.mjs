// The capture "hook command" a real agent CLI invokes on a pre-tool event during
// Tier-2 live conformance. It writes the raw native payload the agent put on
// stdin to the file named by $ACP_CAPTURE_FILE, then exits 0 (allow) so the
// agent proceeds normally — the point is to record the payload the agent
// actually emits, not to gate the call.
//
// Registered as the command hook by write-hook-config.mjs. Node (not shell) so
// it stays lint-clean and portable, and so a missing capture path fails loud
// rather than silently writing nowhere.

import { writeFileSync, readFileSync } from "node:fs";

const target = process.env.ACP_CAPTURE_FILE;
if (!target) {
  process.stderr.write("dump.mjs: ACP_CAPTURE_FILE is not set\n");
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
