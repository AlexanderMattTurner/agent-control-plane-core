#!/usr/bin/env node
/**
 * Codex CLI EXTERNAL_HOOK entry. Reads a native
 * PreToolUse/PermissionRequest/PostToolUse payload on stdin, applies the demo
 * judge, and emits Codex's native response.
 *
 * CODEX VERSION — set `ACP_CODEX_VERSION` to the version of the Codex binary
 * the launcher pinned (for example `ACP_CODEX_VERSION=0.151.0`). Codex's hook
 * stdin carries no version, so without it every call parses observe-only and a
 * deny renders advisory (exit 0). Below v0.135 the render is advisory too,
 * because Codex has no hook veto there.
 *
 * FAILURE POSTURE — fail OPEN (exit 0), like Claude Code: Codex treats a
 * non-conforming hook as non-blocking. The sandbox is the backstop.
 *
 * Usage: `ACP_CODEX_VERSION=0.151.0 node bin/codex-hook.mjs < payload.json`
 */
import { createCodexAdapter } from "../src/adapters/codex.mjs";
import { readStdin, renderHookResponse, emit } from "../src/runtime.mjs";

/** @type {import("../src/control-plane.mjs").NativeResponse} */
const FAIL_OPEN = { transport: "external_hook", exit_code: 0, enforced: false };

const adapter = createCodexAdapter({ version: process.env.ACP_CODEX_VERSION });
emit(renderHookResponse(adapter, await readStdin(), FAIL_OPEN));
