import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codexAdapter,
  canEnforce,
  COVERAGE,
  DEFAULT_DENY_REASON,
  MIN_ENFORCING_VERSION,
} from "../src/adapters/codex.mjs";
import { runAdapterConformance } from "../src/conformance.mjs";
import {
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
      adapter: codexAdapter,
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

describe("codex adapter: allow = abstain by default, soleGate opt-in", () => {
  const event = codexAdapter.parse({
    hook_event_name: "PreToolUse",
    version: "0.135.0",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });

  it("default render never emits permissionDecision on allow", () => {
    const out = codexAdapter.render({ decision: "allow" }, event);
    assert.ok(!("permissionDecision" in out.stdout.hookSpecificOutput));
    assert.equal(out.enforced, false);
    assert.equal(out.exit_code, 0);
  });

  it("soleGate: false (explicit) still abstains", () => {
    const out = codexAdapter.render({ decision: "allow" }, event, {
      soleGate: false,
    });
    assert.ok(!("permissionDecision" in out.stdout.hookSpecificOutput));
  });

  it("soleGate: true emits the real permissionDecision: allow", () => {
    const out = codexAdapter.render({ decision: "allow" }, event, {
      soleGate: true,
    });
    assert.equal(out.stdout.hookSpecificOutput.permissionDecision, "allow");
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

  it("soleGate: true on a non-vetoable (pre-v0.135) event still abstains from enforcement", () => {
    const preEnforcing = codexAdapter.parse({
      hook_event_name: "PreToolUse",
      version: "0.134.9",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const out = codexAdapter.render({ decision: "allow" }, preEnforcing, {
      soleGate: true,
    });
    assert.equal(out.stdout.hookSpecificOutput.permissionDecision, "allow");
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

  it("does not inject a reason on a non-enforced (advisory) deny", () => {
    const preEnforcing = codexAdapter.parse({
      hook_event_name: "PreToolUse",
      version: "0.134.9",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /" },
    });
    const out = codexAdapter.render({ decision: "deny" }, preEnforcing);
    assert.equal(out.enforced, false);
    assert.equal(out.exit_code, 0);
    assert.ok(!("permissionDecisionReason" in out.stdout.hookSpecificOutput));
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
  // the same Bash-only limit as the BUILTIN row) rather than UNKNOWN.
  const shellCall = {
    hook_event_name: "PreToolUse",
    version: "0.151.0",
    tool_name: "shell",
    tool_input: { command: ["ls"] },
  };

  it("a main-thread shell call carries no agent_type and takes the BUILTIN row", () => {
    assert.equal(COVERAGE[CallClass.BUILTIN], CoverageStatus.PARTIAL);
    assert.equal(classifyCallClass("shell", shellCall), CallClass.BUILTIN);
    assert.equal(codexAdapter.parse(shellCall).this_call_vetoable, true);
  });

  it("the same call carrying agent_type classifies SUBAGENT and stays vetoable", () => {
    assert.equal(COVERAGE[CallClass.SUBAGENT], CoverageStatus.PARTIAL);
    const raw = { ...shellCall, agent_id: "sub-1", agent_type: "default" };
    assert.equal(classifyCallClass("shell", raw), CallClass.SUBAGENT);
    assert.equal(codexAdapter.parse(raw).this_call_vetoable, true);
  });

  it("an MCP-named tool takes the MCP row whether or not a subagent made it", () => {
    for (const extra of [{}, { agent_type: "default" }]) {
      const event = codexAdapter.parse({
        ...shellCall,
        ...extra,
        tool_name: "mcp__github__create_issue",
      });
      assert.equal(event.this_call_vetoable, false);
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

  // The COVERAGE rows describe which calls reach PreToolUse. A PostToolUse
  // payload is proof the post-tool hook fired for THIS call, so the pre-tool MCP
  // row must not answer for it — the pre-tool half is the positive marker that
  // the row is still live where it applies.
  it("an MCP tool is vetoable post-tool though COVERAGE[mcp] is uncovered", () => {
    const mcp = { ...postCall, tool_name: "mcp__github__create_issue" };
    assert.equal(COVERAGE[CallClass.MCP], CoverageStatus.UNCOVERED);
    assert.equal(codexAdapter.parse(mcp).this_call_vetoable, true);
    assert.equal(
      codexAdapter.parse({ ...mcp, hook_event_name: "PreToolUse" })
        .this_call_vetoable,
      false,
    );
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
