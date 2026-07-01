/**
 * agent-control-plane — vendor-neutral control-plane contract for coding agents.
 *
 * Re-exports the normalized {@link ToolCallEvent}/{@link Verdict} contract, the
 * reference adapters (Claude Code, Codex), and the conformance harness every
 * adapter must pass. Individual adapters are also reachable at the subpath
 * exports `agent-control-plane/claude` and `agent-control-plane/codex`, and the
 * harness at `agent-control-plane/conformance`.
 */

export * from "./control-plane.mjs";
export { claudeAdapter, HookEvent } from "./adapters/claude.mjs";
export { codexAdapter } from "./adapters/codex.mjs";
export { runAdapterConformance } from "./conformance.mjs";
