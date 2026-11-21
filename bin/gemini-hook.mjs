#!/usr/bin/env node
/**
 * Gemini CLI EXTERNAL_HOOK entry. Reads a native BeforeTool payload on stdin,
 * applies the demo judge, and emits Gemini's native response.
 *
 * FAILURE POSTURE — fail OPEN (exit 0), its `HOST_FAILURE` row in
 * `src/runtime.mjs`. `ACP_FAIL_CLOSED=1` blocks instead (exit 2).
 *
 * Usage: `node bin/gemini-hook.mjs < payload.json`
 */
import { geminiAdapter } from "../src/adapters/gemini.mjs";
import { runHookEntry } from "../src/runtime.mjs";

await runHookEntry(geminiAdapter);
