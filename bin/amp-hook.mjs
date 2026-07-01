#!/usr/bin/env node
/**
 * Amp EXTERNAL_HOOK entry (pure exit-code transport, no stdout body). Reads a
 * delegate payload on stdin, applies the demo judge, and exits with Amp's
 * decision code (0 allow / 1 ask / 2 reject).
 *
 * FAILURE POSTURE — fail to ASK (exit 1), NOT allow. Amp's delegate reads exit 1
 * as "ask the human," which is the safe degradation when the guardrail itself is
 * broken: neither silently allowing (exit 0) nor hard-denying (exit 2) a call it
 * never actually judged. This is the asymmetry the per-host split exists for —
 * Amp has a safe "ask" failure code that Claude Code's transport does not.
 *
 * Usage: `node bin/amp-hook.mjs < payload.json`
 */
import { ampAdapter } from "../src/adapters/amp.mjs";
import { readStdin, renderHookResponse, emit } from "./hook-runtime.mjs";

/** @type {import("../src/control-plane.mjs").NativeResponse} */
const FAIL_ASK = { transport: "external_hook", exit_code: 1, enforced: false };

emit(renderHookResponse(ampAdapter, await readStdin(), FAIL_ASK));
