#!/usr/bin/env node
/**
 * Claude Code EXTERNAL_HOOK entry. Reads a native PreToolUse payload on stdin,
 * applies the demo judge, and emits Claude Code's native response.
 *
 * FAILURE POSTURE — fail OPEN. Claude Code treats a hook that crashes, times out,
 * or emits a non-conforming body as "no objection" and runs the tool anyway, so
 * on any internal failure this exits 0 with no body rather than pretending to a
 * decision it couldn't compute. A broken guardrail must not wedge the user; the
 * sandbox is the real backstop, not this hook.
 *
 * Usage: `node bin/claude-hook.mjs < payload.json`
 */
import { claudeAdapter } from "../src/adapters/claude.mjs";
import { readStdin, renderHookResponse, emit } from "./hook-runtime.mjs";

/** @type {import("../src/control-plane.mjs").NativeResponse} */
const FAIL_OPEN = { transport: "external_hook", exit_code: 0, enforced: false };

emit(renderHookResponse(claudeAdapter, await readStdin(), FAIL_OPEN));
