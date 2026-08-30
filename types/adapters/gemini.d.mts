/**
 * Parse a raw Gemini CLI hook payload into a normalized {@link ToolCallEvent}.
 * Never throws on an unmodelled event type or tool-input field. A payload comes
 * from a hooks-capable Gemini (v0.26.0+) whose `BeforeTool` can pre-empt builtin
 * tools via exit 2. But MCP firing is only medium-confidence (COVERAGE.mcp is
 * UNKNOWN), so an MCP-sourced call — flagged by `mcp_context` or an `mcp_`-named
 * tool — parses non-vetoable until an item-⑤ probe confirms the hook fires.
 * `BeforeAgent` (fires after the user submits a prompt, before planning) maps to
 * `prompt_submit`: no tool, the submitted text folded into `input.prompt`.
 * @param {any} native
 * @returns {ToolCallEvent}
 */
export function parse(native: any): ToolCallEvent;
/**
 * Render into Gemini CLI's native external-hook transport. An enforceable deny
 * renders as exit 2 (the System Block on BeforeTool; documented on BeforeAgent
 * as "same as decision: deny" — it aborts the turn); everything else exits 0
 * with a JSON decision body (or none, when `allow` abstains). `soleGate`
 * (default false) is the same dangerous opt-in as the other adapters: it makes
 * an `allow` emit the real `decision: "allow"` instead of abstaining (tool
 * events only — BeforeAgent documents no allow behavior to opt into).
 * @param {Verdict} verdict
 * @param {ToolCallEvent} event
 * @param {{ soleGate?: boolean }} [options]
 * @returns {NativeResponse}
 */
export function render(verdict: Verdict, event: ToolCallEvent, { soleGate }?: {
    soleGate?: boolean;
}): NativeResponse;
/** @typedef {import("../control-plane.mjs").ToolCallEvent} ToolCallEvent */
/** @typedef {import("../control-plane.mjs").Verdict} Verdict */
/** @typedef {import("../control-plane.mjs").NativeResponse} NativeResponse */
/** @typedef {import("../control-plane.mjs").EventMeta} EventMeta */
export const AGENT: "gemini";
export const INTEGRATION_MODE: "external_hook";
/**
 * Hook-coverage matrix row (`docs/hook-coverage-matrix.md`). `BeforeTool` gates
 * builtins on v0.26+ (COVERED). MCP routing through the same matcher is only
 * MEDIUM-confidence and unproven, subagent firing for a loaded agent is
 * undocumented, and resumed-session behavior has no source — all three are
 * UNKNOWN, held at fail-closed until an item-⑤ probe upgrades them. A guessed ✅
 * here would be a silent fail-open.
 */
/** @type {import("../control-plane.mjs").CoverageMap} */
export const COVERAGE: import("../control-plane.mjs").CoverageMap;
/**
 * Which {@link VERDICT_CONTENT_FIELDS} have no native channel on each event
 * kind, so `render` drops them. Gemini CLI documents
 * `hookSpecificOutput.tool_input` on BeforeTool, `systemMessage` on the tool
 * events and `hookSpecificOutput.additionalContext` on BeforeAgent. It documents
 * NO AfterTool output-rewrite field, so `mutated_output` is dropped on every
 * kind. `mutated_input` is dropped everywhere
 * but BeforeTool: the tool has already run by AfterTool, and BeforeAgent has no
 * tool input at all, so emitting `tool_input` there names a channel the host
 * ignores while reading to the caller as a mutation applied.
 *
 * ALLOW path only. The enforced-deny branch of `render` returns no stdout at
 * all, so a deny drops `additional_context` too, on every kind — these rows do
 * not describe it.
 *
 * AfterTool is GATED here, so a redaction verdict does reach this adapter and
 * cannot be honoured. It renders {@link POST_TOOL_REDACTION_UNSUPPORTED} on
 * `systemMessage` instead, so the model is told the output above it is
 * unredacted rather than left to read it as vetted. The raw output still reaches
 * the model; a guardrail that must actually redact has to deny.
 * @type {Record<string, ReadonlySet<string>|undefined>}
 */
export const UNRENDERED_FIELDS: Record<string, ReadonlySet<string> | undefined>;
/**
 * What the model is told when a verdict redacts an AfterTool output Gemini has
 * no channel to replace. Exported so a caller composing its own `systemMessage`
 * can recognize it; recognize it with `endsWith`, never equality, because a
 * verdict carrying `additional_context` too puts that context first (see
 * {@link decisionBody}).
 */
export const POST_TOOL_REDACTION_UNSUPPORTED: string;
/** Gemini CLI native hook event names (the `hook_event_name` field). */
export const HookEvent: Readonly<{
    BEFORE_TOOL: "BeforeTool";
    AFTER_TOOL: "AfterTool";
    BEFORE_AGENT: "BeforeAgent";
}>;
/**
 * The native event a conformance probe should carry for each kind — this
 * adapter's own answer, so an every-kind probe exercises the branch that kind
 * really takes. `session_start` and `unknown` have no Gemini event and are
 * absent.
 * @type {Record<string, string|undefined>}
 */
export const NATIVE_EVENT_FOR: Record<string, string | undefined>;
/**
 * Adapter-scoped native-builtin → canonical tool aliases, applied ONLY when a
 * call classifies as BUILTIN. These names are too generic for the global
 * {@link TOOL_ALIASES} (an MCP server could export a `read_file`), but Gemini
 * CLI removes the ambiguity at parse time: every MCP tool is unconditionally
 * registered — and surfaced in hook payloads — under its fully qualified
 * `mcp_{server}_{tool}` name (gemini-cli docs/tools/mcp-server.md), so a bare
 * builtin name in `tool_name` can only be the builtin. Renaming the tool also
 * renames its INPUT to the schema that name advertises, via
 * {@link GEMINI_INPUT_ALIASES}, and the rename must actually produce that key or
 * the call keeps its native name (see {@link geminiCall}) — a consumer told
 * `event.tool` is `Read` reads `input.file_path` and finds it, rather than
 * reading `undefined` off a forwarded `absolute_path` and allowing. Targets are
 * pinned to {@link MODELED_TOOLS} at import, every entry must be witnessed by a gemini
 * conformance fixture (`assertToolAliasesCovered`), and every aliased case must
 * carry the canonical input key (`assertAliasedInputsCanonical`).
 * @type {Readonly<Record<string, string>>}
 */
export const GEMINI_TOOL_ALIASES: Readonly<Record<string, string>>;
/** @type {import("../control-plane.mjs").Adapter} */
export const geminiAdapter: import("../control-plane.mjs").Adapter;
export type ToolCallEvent = import("../control-plane.mjs").ToolCallEvent;
export type Verdict = import("../control-plane.mjs").Verdict;
export type NativeResponse = import("../control-plane.mjs").NativeResponse;
export type EventMeta = import("../control-plane.mjs").EventMeta;
