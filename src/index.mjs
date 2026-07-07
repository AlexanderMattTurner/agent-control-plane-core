/**
 * agent-control-plane-core — vendor-neutral control-plane contract for coding agents.
 *
 * Re-exports the normalized {@link ToolCallEvent}/{@link Verdict} contract, the
 * transport-agnostic core (integration modes + {@link NativeResponse}), the
 * reference adapters, and the conformance harness every adapter must pass.
 * Individual adapters are also reachable at the subpath exports
 * `agent-control-plane-core/claude`, `/codex`, `/amp`, `/gemini`, and the
 * harness at `/conformance`.
 */

export * from "./control-plane.mjs";
export { claudeAdapter, HookEvent } from "./adapters/claude.mjs";
export { codexAdapter } from "./adapters/codex.mjs";
export { ampAdapter } from "./adapters/amp.mjs";
export { geminiAdapter } from "./adapters/gemini.mjs";
export {
  runAdapterConformance,
  assertCoverageWellFormed,
  assertToolAliasesCovered,
} from "./conformance.mjs";
