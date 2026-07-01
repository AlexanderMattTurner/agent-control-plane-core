#!/usr/bin/env node
/**
 * Codex CLI EXTERNAL_HOOK entry. Reads a native PreToolUse/PermissionRequest
 * payload on stdin, applies the demo judge, and emits Codex's native response.
 *
 * FAILURE POSTURE — fail OPEN (exit 0), like Claude Code: Codex treats a
 * non-conforming hook as non-blocking. On a pre-v0.135 Codex the render is
 * advisory anyway (the adapter marks it observe-only), so a failure and a
 * successful advisory both leave the tool to proceed — the sandbox is the
 * backstop.
 *
 * Usage: `node bin/codex-hook.mjs < payload.json`
 */
import { codexAdapter } from "../src/adapters/codex.mjs";
import { readStdin, renderHookResponse, emit } from "./hook-runtime.mjs";

/** @type {import("../src/control-plane.mjs").NativeResponse} */
const FAIL_OPEN = { transport: "external_hook", exit_code: 0, enforced: false };

emit(renderHookResponse(codexAdapter, await readStdin(), FAIL_OPEN));
