#!/usr/bin/env node
/**
 * Claude Code EXTERNAL_HOOK entry. Reads a native PreToolUse payload on stdin,
 * applies the demo judge, and emits Claude Code's native response.
 *
 * FAILURE POSTURE — fail OPEN (exit 0), its `HOST_FAILURE` row in
 * `src/runtime.mjs`. `ACP_FAIL_CLOSED=1` blocks instead (exit 2).
 *
 * Usage: `node bin/claude-hook.mjs < payload.json`
 */
import { claudeAdapter } from "../src/adapters/claude.mjs";
import { runHookEntry } from "../src/runtime.mjs";

await runHookEntry(claudeAdapter);
