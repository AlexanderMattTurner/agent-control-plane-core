import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codexAdapter,
  createCodexAdapter,
  canEnforce,
  COVERAGE,
  MIN_ENFORCING_VERSION,
} from "../src/adapters/codex.mjs";
import { runAdapterConformance } from "../src/conformance.mjs";
import { capturedAdapter } from "../.github/scripts/live-capture/assert-captured.mjs";
import {
  DEFAULT_DENY_REASON,
  CallClass,
  classifyCallClass,
  CoverageStatus,
  EventKind,
} from "../src/control-plane.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, "..", "src", "fixtures", "codex.json"), "utf8"),
);

describe("codex adapter conformance", () => {
  it("parse/render golden across PreToolUse, PermissionRequest, and the version gate", () => {
    const summary = runAdapterConformance({
      adapter: capturedAdapter("codex"),
      fixtures,
      assert,
    });
    assert.ok(summary.cases >= 3);
    assert.equal(summary.mutationSeen, true);
    assert.equal(summary.enforcedDenySeen, true);
    for (const decision of ["allow", "deny", "ask"])
      assert.ok(summary.decisionsSeen.has(decision));
  });

  it("declares AGENT and external_hook integration", () => {
    assert.equal(codexAdapter.AGENT, "codex");
    assert.equal(codexAdapter.INTEGRATION_MODE, "external_hook");
  });
});

describe("codex adapter: a pre-tool allow abstains; Codex has no bare allow", () => {
  const event = codexAdapter.parse({
    hook_event_name: "PreToolUse",
    version: "0.135.0",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });

  // Codex rejects `permissionDecision: "allow"` without `updatedInput`
  // ("unsupported permissionDecision:allow", output_parser.rs at both
  // rust-v0.135.0 and rust-v0.166.0): the run fails and the call runs under
  // Codex's own approval anyway. So no soleGate setting may emit one.
  for (const [label, options] of [
    ["by default", undefined],
    ["with soleGate: false", { soleGate: false }],
    ["with soleGate: true", { soleGate: true }],
  ])
    it(`renders a bare allow as {hookEventName} alone ${label}`, () => {
      const out = codexAdapter.render({ decision: "allow" }, event, options);
      assert.deepEqual(out.stdout, {
        hookSpecificOutput: { hookEventName: "PreToolUse" },
      });
      assert.equal(out.enforced, false);
      assert.equal(out.exit_code, 0);
    });

  it("soleGate: true does not change deny rendering", () => {
    const denyDefault = codexAdapter.render(
      { decision: "deny", reason: "r" },
      event,
    );
    const denySoleGate = codexAdapter.render(
      { decision: "deny", reason: "r" },
      event,
      { soleGate: true },
    );
    assert.deepEqual(denyDefault, denySoleGate);
  });
});

describe("codex render: PreToolUse bodies Codex 0.166 applies", () => {
  const event = codexAdapter.parse({
    hook_event_name: "PreToolUse",
    version: "0.166.0",
    tool_name: "Bash",
    tool_input: { command: "rm -rf build" },
  });

  for (const [label, verdict, hookSpecificOutput] of [
    [
      "a mutation on a default allow pairs updatedInput with allow",
      { decision: "allow", mutated_input: { command: "rm -rf ./build" } },
      {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: "rm -rf ./build" },
      },
    ],
    [
      "context on an allow rides additionalContext",
      { decision: "allow", additional_context: "build is generated" },
      { hookEventName: "PreToolUse", additionalContext: "build is generated" },
    ],
    [
      "a mutation with context carries both",
      {
        decision: "allow",
        mutated_input: { command: "rm -rf ./build" },
        additional_context: "c",
      },
      {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: "rm -rf ./build" },
        additionalContext: "c",
      },
    ],
    [
      "a deny's body drops updatedInput, which Codex rejects without allow",
      {
        decision: "deny",
        reason: "no",
        mutated_input: { command: "true" },
        additional_context: "c",
      },
      {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "no",
        additionalContext: "c",
      },
    ],
  ])
    it(label, () => {
      assert.deepEqual(codexAdapter.render(verdict, event).stdout, {
        hookSpecificOutput,
      });
    });
});

describe("codex render: an advisory PreToolUse deny still carries a reason", () => {
  // Codex voids a deny body with an empty reason, context and all, whether or
  // not this adapter could confirm the host enforces it.
  for (const [label, version] of [
    ["with no version", undefined],
    ["below v0.135", "0.134.9"],
  ])
    it(`fills the default reason so additionalContext survives ${label}`, () => {
      const advisory = codexAdapter.parse({
        hook_event_name: "PreToolUse",
        version,
        tool_name: "Bash",
        tool_input: { command: "rm -rf build" },
      });
      const out = codexAdapter.render(
        { decision: "deny", additional_context: "c" },
        advisory,
      );
      assert.equal(out.enforced, false);
      assert.equal(out.exit_code, 0);
      assert.deepEqual(out.stdout, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: DEFAULT_DENY_REASON,
          additionalContext: "c",
        },
      });
    });
});

describe("codex render: PermissionRequest answers in its own schema", () => {
  const event = codexAdapter.parse({
    hook_event_name: "PermissionRequest",
    version: "0.166.0",
    tool_name: "Bash",
    tool_input: { command: "curl example.com" },
  });
  const content = {
    mutated_input: { command: "true" },
    additional_context: "c",
  };

  for (const [label, verdict, options, expected, exitCode] of [
    [
      "a deny is decision.behavior deny with the reason as message",
      { decision: "deny", reason: "no network", ...content },
      undefined,
      {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "no network" },
      },
      2,
    ],
    [
      "an enforced deny with no reason still carries a message",
      { decision: "deny" },
      undefined,
      {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: DEFAULT_DENY_REASON },
      },
      2,
    ],
    [
      "an ask is a deny",
      { decision: "ask", reason: "confirm" },
      undefined,
      {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "confirm" },
      },
      2,
    ],
    [
      "an allow abstains by default",
      { decision: "allow", ...content },
      undefined,
      { hookEventName: "PermissionRequest" },
      0,
    ],
    [
      "an allow under soleGate grants the approval",
      { decision: "allow", ...content },
      { soleGate: true },
      { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
      0,
    ],
  ])
    it(label, () => {
      const out = codexAdapter.render(verdict, event, options);
      assert.deepEqual(out.stdout, { hookSpecificOutput: expected });
      assert.equal(out.exit_code, exitCode);
    });

  const advisory = codexAdapter.parse({
    hook_event_name: "PermissionRequest",
    version: "0.134.9",
    tool_name: "Bash",
    tool_input: { command: "curl example.com" },
  });
  for (const [label, verdict, options, decision] of [
    [
      "an advisory deny below v0.135 injects no message",
      { decision: "deny" },
      undefined,
      { behavior: "deny" },
    ],
    [
      "an allow under soleGate below v0.135 still grants the approval",
      { decision: "allow" },
      { soleGate: true },
      { behavior: "allow" },
    ],
  ])
    it(label, () => {
      const out = codexAdapter.render(verdict, advisory, options);
      assert.deepEqual(out.stdout, {
        hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
      });
      assert.equal(out.enforced, false);
      assert.equal(out.exit_code, 0);
    });
});

describe("codex adapter: enforced deny always carries a non-empty reason (Codex fails open otherwise)", () => {
  const event = codexAdapter.parse({
    hook_event_name: "PreToolUse",
    version: "0.135.0",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /" },
  });

  it("supplies a default reason when an enforced deny has none", () => {
    const out = codexAdapter.render({ decision: "deny" }, event);
    assert.equal(out.enforced, true);
    assert.equal(out.exit_code, 2);
    const reason = out.stdout.hookSpecificOutput.permissionDecisionReason;
    assert.equal(reason, DEFAULT_DENY_REASON);
  });

  it("replaces an empty-string reason on an enforced deny", () => {
    const out = codexAdapter.render({ decision: "deny", reason: "" }, event);
    assert.equal(
      out.stdout.hookSpecificOutput.permissionDecisionReason,
      DEFAULT_DENY_REASON,
    );
  });

  it("preserves a real reason on an enforced deny", () => {
    const out = codexAdapter.render(
      { decision: "deny", reason: "destructive delete" },
      event,
    );
    assert.equal(
      out.stdout.hookSpecificOutput.permissionDecisionReason,
      "destructive delete",
    );
  });
});

describe("codex: the launcher pins the version, because Codex's stdin has none", () => {
  const call = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  };

  it("a launcher version at or above v0.135 enforces a payload with no version", () => {
    const adapter = createCodexAdapter({ version: "0.151.0" });
    const event = adapter.parse(call);
    assert.equal(event.this_call_vetoable, true);
    assert.equal(event.meta.integration_mode, "external_hook");
  });

  it("the shipped adapter, given no version anywhere, stays advisory", () => {
    const event = codexAdapter.parse(call);
    assert.equal(event.this_call_vetoable, false);
    assert.equal(event.meta.integration_mode, "observe_only");
  });

  it("the launcher version wins over a payload version, in both directions", () => {
    const pinnedOld = createCodexAdapter({ version: "0.134.0" });
    assert.equal(
      pinnedOld.parse({ ...call, version: "0.151.0" }).this_call_vetoable,
      false,
    );
    const pinnedNew = createCodexAdapter({ version: "0.151.0" });
    assert.equal(
      pinnedNew.parse({ ...call, version: "0.134.0" }).this_call_vetoable,
      true,
    );
  });

  it("with no launcher version, a payload version is the fallback", () => {
    assert.equal(
      codexAdapter.parse({ ...call, version: "0.151.0" }).this_call_vetoable,
      true,
    );
  });
});

describe("canEnforce version gate (≥ v0.135)", () => {
  // Driven per boundary so just-below / exactly-at / above / prerelease /
  // garbage each pin a distinct branch. Fail-closed: anything semver.coerce
  // can't resolve to a version stays advisory (false).
  for (const [version, expected] of [
    ["0.135.0", true], // exactly at threshold
    ["0.135.1", true], // patch above
    ["0.136.0", true], // minor above
    ["0.200.1", true],
    ["1.0.0", true], // major above
    ["0.134.9", false], // just below
    ["0.134.999", false], // just below, high patch
    ["0.0.0", false],
    ["0.135.0-rc.1", true], // prerelease of the threshold coerces to 0.135.0
    ["0.135.0-beta+sha", true], // prerelease + build metadata
    ["0.134.0-rc.9", false], // prerelease below the threshold
    ["v0.135.0", true], // leading-v tolerated by coerce
    ["", false], // missing → fail closed
    ["abc", false], // garbage → fail closed
    ["0", false], // partial coerces to 0.0.0 → fail closed
    [undefined, false], // non-string → fail closed
    [null, false],
    [135, false], // non-string number → fail closed
  ]) {
    it(`${JSON.stringify(version)} -> ${expected}`, () => {
      assert.equal(canEnforce(version), expected);
    });
  }

  // drift-guard-ok: the table above is a set of concrete, readable exemplar
  // versions kept for regression value — deriving it algorithmically would lose
  // that readability. This test instead derives the BOUNDARY from
  // MIN_ENFORCING_VERSION so a threshold bump can't leave the hardcoded table
  // asserting a stale boundary. At-threshold enforces; the highest patch of the
  // prior minor does not.
  it("derives the boundary from MIN_ENFORCING_VERSION", () => {
    const [maj, min] = MIN_ENFORCING_VERSION;
    assert.equal(canEnforce(`${maj}.${min}.0`), true);
    assert.equal(canEnforce(`${maj}.${min - 1}.999`), false);
  });
});

describe("codex: an unmodelled event is never vetoable, even on an enforcing version", () => {
  // Codex routes every event other than PreToolUse/PermissionRequest/PostToolUse
  // into EventKind.UNKNOWN, so this is its ordinary path rather than drift. On an
  // enforcing version the coverage map alone answered "vetoable", and the render
  // then claimed a block Codex never performs for a SessionStart payload.
  for (const nativeEvent of ["SessionStart", "Stop", "Notification"]) {
    it(`${nativeEvent} parses unknown and renders no enforced block`, () => {
      const event = codexAdapter.parse({
        hook_event_name: nativeEvent,
        version: "9999.0.0",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      assert.equal(event.event, EventKind.UNKNOWN);
      assert.equal(event.this_call_vetoable, false);
      const out = codexAdapter.render({ decision: "deny", reason: "r" }, event);
      assert.equal(out.enforced, false);
      assert.equal(out.exit_code, 0);
    });
  }

  // Positive marker: the same enforcing version DOES veto the event Codex gates,
  // so the cases above are the event kind being read and not the version gate
  // answering for it.
  it("the same version still enforces a PreToolUse deny", () => {
    const event = codexAdapter.parse({
      hook_event_name: "PreToolUse",
      version: "9999.0.0",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    assert.equal(event.this_call_vetoable, true);
    assert.equal(
      codexAdapter.render({ decision: "deny", reason: "r" }, event).enforced,
      true,
    );
  });
});

describe("codex: a subagent's call takes the SUBAGENT row, not the BUILTIN one", () => {
  // A live item-⑤ probe drove a real Codex subagent and read back
  // agent_type=default / agent_id=<the one SubagentStart announced> on its
  // PreToolUse payload, with agent_type absent on the main thread's — so the
  // field discriminates, and the SUBAGENT row is PARTIAL (the hook fires, under
  // the same limits as the BUILTIN row) rather than UNKNOWN.
  const shellCall = {
    hook_event_name: "PreToolUse",
    version: "0.151.0",
    tool_name: "Bash",
    tool_input: { command: ["ls"] },
  };

  it("a main-thread shell call carries no agent_type and takes the BUILTIN row", () => {
    assert.equal(COVERAGE[CallClass.BUILTIN], CoverageStatus.PARTIAL);
    assert.equal(classifyCallClass("Bash", shellCall), CallClass.BUILTIN);
    assert.equal(codexAdapter.parse(shellCall).this_call_vetoable, true);
  });

  it("the same call carrying agent_type classifies SUBAGENT and stays vetoable", () => {
    assert.equal(COVERAGE[CallClass.SUBAGENT], CoverageStatus.PARTIAL);
    const raw = { ...shellCall, agent_id: "sub-1", agent_type: "default" };
    assert.equal(classifyCallClass("Bash", raw), CallClass.SUBAGENT);
    assert.equal(codexAdapter.parse(raw).this_call_vetoable, true);
  });

  it("an MCP-named tool takes the MCP row whether or not a subagent made it", () => {
    for (const extra of [{}, { agent_type: "default" }]) {
      const event = codexAdapter.parse({
        ...shellCall,
        ...extra,
        tool_name: "mcp__github__create_issue",
      });
      assert.equal(event.this_call_vetoable, true);
    }
  });
});

describe("codex: PostToolUse parses post_tool and blocks on the post-tool schema", () => {
  const postCall = {
    hook_event_name: "PostToolUse",
    version: "0.151.0",
    tool_name: "Bash",
    tool_input: { command: "cat .env" },
    tool_response: "OPENAI_API_KEY=sk-live-1",
  };

  it("carries tool_response into response and parses vetoable", () => {
    const event = codexAdapter.parse(postCall);
    assert.equal(event.event, EventKind.POST_TOOL);
    assert.equal(event.response, "OPENAI_API_KEY=sk-live-1");
    assert.equal(event.this_call_vetoable, true);
  });

  it("renders a deny as decision:block + exit 2, never permissionDecision", () => {
    const out = codexAdapter.render(
      { decision: "deny", reason: "leaked credential" },
      codexAdapter.parse(postCall),
    );
    assert.equal(out.enforced, true);
    assert.equal(out.exit_code, 2);
    assert.equal(out.stdout.decision, "block");
    assert.equal(out.stdout.reason, "leaked credential");
    // permissionDecision is parsed but inert on PostToolUse, so emitting it
    // would read as a block that never bites.
    assert.equal(
      Object.hasOwn(out.stdout.hookSpecificOutput, "permissionDecision"),
      false,
    );
  });

  it("guarantees a non-empty reason on a reasonless enforced block", () => {
    const out = codexAdapter.render(
      { decision: "deny" },
      codexAdapter.parse(postCall),
    );
    assert.equal(out.stdout.reason, DEFAULT_DENY_REASON);
  });

  it("carries additional_context but drops mutated_output", () => {
    const out = codexAdapter.render(
      {
        decision: "allow",
        additional_context: "1 secret in this output",
        mutated_output: "[REDACTED]",
      },
      codexAdapter.parse(postCall),
    );
    assert.equal(
      out.stdout.hookSpecificOutput.additionalContext,
      "1 secret in this output",
    );
    assert.deepEqual(Object.keys(out.stdout), ["hookSpecificOutput"]);
    assert.equal(
      Object.hasOwn(out.stdout.hookSpecificOutput, "updatedToolOutput"),
      false,
    );
  });

  it("stays advisory on a pre-0.135 Codex", () => {
    const event = codexAdapter.parse({ ...postCall, version: "0.134.0" });
    assert.equal(event.this_call_vetoable, false);
    const out = codexAdapter.render({ decision: "deny", reason: "r" }, event);
    assert.equal(out.enforced, false);
    assert.equal(out.exit_code, 0);
  });

  // Codex runs PreToolUse for an MCP call at every enforcing version, so a deny
  // there is a block Codex performs and the render must report it enforced.
  it("an MCP tool is vetoable pre-tool and post-tool", () => {
    const mcp = { ...postCall, tool_name: "mcp__github__create_issue" };
    assert.equal(COVERAGE[CallClass.MCP], CoverageStatus.PARTIAL);
    assert.equal(codexAdapter.parse(mcp).this_call_vetoable, true);
    const pre = codexAdapter.parse({ ...mcp, hook_event_name: "PreToolUse" });
    assert.equal(pre.this_call_vetoable, true);
    assert.equal(codexAdapter.render({ decision: "deny" }, pre).enforced, true);
  });
});

describe("codex render: an unmodelled event claims no content channel", () => {
  // An event the adapter could not name has no channel it can claim: `updatedInput`
  // there names a key the host ignores while reading to the caller as a mutation
  // applied.
  const unknown = codexAdapter.parse({
    hook_event_name: "PreCompact",
    version: "9999.0.0",
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
  });

  it("parses PreCompact as UNKNOWN", () => {
    assert.equal(unknown.event, "unknown");
  });

  it("drops mutated_input there, but still carries it on PreToolUse", () => {
    const dropped = codexAdapter.render(
      { decision: "allow", mutated_input: { command: "echo safe" } },
      unknown,
    );
    assert.equal(
      Object.hasOwn(dropped.stdout.hookSpecificOutput, "updatedInput"),
      false,
    );
    const preTool = codexAdapter.parse({
      hook_event_name: "PreToolUse",
      version: "9999.0.0",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
    });
    assert.deepEqual(
      codexAdapter.render(
        { decision: "allow", mutated_input: { command: "echo safe" } },
        preTool,
      ).stdout.hookSpecificOutput.updatedInput,
      { command: "echo safe" },
    );
  });
});
