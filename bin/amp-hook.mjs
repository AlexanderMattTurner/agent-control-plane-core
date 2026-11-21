#!/usr/bin/env node
/**
 * Amp EXTERNAL_HOOK entry (pure exit-code transport, no stdout body). Reads a
 * delegate payload on stdin, applies the demo judge, and exits with Amp's
 * decision code (0 allow / 1 ask / 2 reject).
 *
 * FAILURE POSTURE — fail to ASK (exit 1), its `HOST_FAILURE` row in
 * `src/runtime.mjs`. `ACP_FAIL_CLOSED=1` blocks instead (exit 2).
 *
 * Usage: `node bin/amp-hook.mjs < payload.json`
 */
import { ampAdapter } from "../src/adapters/amp.mjs";
import { runHookEntry } from "../src/runtime.mjs";

await runHookEntry(ampAdapter);
