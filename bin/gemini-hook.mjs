#!/usr/bin/env node
/**
 * Gemini CLI EXTERNAL_HOOK entry. Reads a native BeforeTool payload on stdin,
 * applies the demo judge, and emits Gemini's native response.
 *
 * FAILURE POSTURE — fail OPEN (exit 0). Gemini CLI treats a non-2 / crashed hook
 * exit as a non-fatal warning and continues, so on any internal failure this
 * exits 0 rather than emitting a spurious System Block (only a clean deny exits
 * 2). A broken guardrail must not wedge the user; the sandbox is the backstop.
 *
 * Usage: `node bin/gemini-hook.mjs < payload.json`
 */
import { geminiAdapter } from "../src/adapters/gemini.mjs";
import { readStdin, renderHookResponse, emit } from "./hook-runtime.mjs";

/** @type {import("../src/control-plane.mjs").NativeResponse} */
const FAIL_OPEN = { transport: "external_hook", exit_code: 0, enforced: false };

emit(renderHookResponse(geminiAdapter, await readStdin(), FAIL_OPEN));
