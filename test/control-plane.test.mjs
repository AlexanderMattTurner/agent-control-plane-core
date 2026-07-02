import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_PLANE_SCHEMA,
  SCHEMA_VERSION,
  EventKind,
  Decision,
  IntegrationMode,
  CallClass,
  CALL_CLASSES,
  CoverageStatus,
  coverageAllowsVeto,
  isCoverageStatus,
  classifyCallClass,
  MODELED_TOOLS,
  makeEvent,
  normalizeVerdict,
  collectPassthrough,
  nativeResponse,
  asObject,
  asString,
  asStringOrNull,
} from "../src/control-plane.mjs";
import { claudeAdapter } from "../src/adapters/claude.mjs";
import { codexAdapter } from "../src/adapters/codex.mjs";
import { ampAdapter } from "../src/adapters/amp.mjs";

describe("control-plane contract is frozen and versioned", () => {
  it("pins the schema version (a bump must be deliberate)", () => {
    assert.equal(SCHEMA_VERSION, 1);
    assert.equal(CONTROL_PLANE_SCHEMA, "control-plane/v1");
  });

  it("freezes the vocabulary enums", () => {
    assert.ok(Object.isFrozen(EventKind));
    assert.ok(Object.isFrozen(Decision));
    assert.ok(Object.isFrozen(IntegrationMode));
    assert.ok(Object.isFrozen(MODELED_TOOLS));
    assert.ok(Object.isFrozen(CallClass));
    assert.ok(Object.isFrozen(CALL_CLASSES));
    assert.ok(Object.isFrozen(CoverageStatus));
  });

  it("exposes the exact kinds, decisions, integration modes, and modeled tools", () => {
    assert.deepEqual(EventKind, {
      PRE_TOOL: "pre_tool",
      POST_TOOL: "post_tool",
      PROMPT_SUBMIT: "prompt_submit",
      SESSION_START: "session_start",
      UNKNOWN: "unknown",
    });
    assert.deepEqual(Decision, { ALLOW: "allow", DENY: "deny", ASK: "ask" });
    assert.deepEqual(IntegrationMode, {
      EXTERNAL_HOOK: "external_hook",
      IN_PROCESS: "in_process",
      OBSERVE_ONLY: "observe_only",
    });
    assert.deepEqual(
      [...MODELED_TOOLS],
      ["Bash", "Edit", "Write", "Read", "WebFetch"],
    );
  });

  it("exposes the exact call classes and coverage statuses", () => {
    assert.deepEqual(CallClass, {
      BUILTIN: "builtin",
      MCP: "mcp",
      SUBAGENT: "subagent",
      RESUMED: "resumed",
    });
    assert.deepEqual(
      [...CALL_CLASSES],
      ["builtin", "mcp", "subagent", "resumed"],
    );
    assert.deepEqual(CoverageStatus, {
      COVERED: "covered",
      PARTIAL: "partial",
      UNCOVERED: "uncovered",
      UNKNOWN: "unknown",
    });
  });
});

describe("coverage helpers encode the ❓-is-❌ doctrine", () => {
  it("coverageAllowsVeto: only covered and partial permit a veto", () => {
    assert.equal(coverageAllowsVeto("covered"), true);
    assert.equal(coverageAllowsVeto("partial"), true);
    assert.equal(coverageAllowsVeto("uncovered"), false);
    assert.equal(coverageAllowsVeto("unknown"), false);
  });

  it("coverageAllowsVeto throws on an unrecognized status", () => {
    assert.throws(() => coverageAllowsVeto("maybe"), /invalid coverage status/);
  });

  it("isCoverageStatus recognizes exactly the four statuses", () => {
    for (const s of ["covered", "partial", "uncovered", "unknown"])
      assert.equal(isCoverageStatus(s), true);
    for (const s of ["", "MAYBE", "cover", undefined, null])
      assert.equal(isCoverageStatus(s), false);
  });
});

describe("classifyCallClass detects MCP, defaults undetectable to builtin", () => {
  for (const [tool, native, expected] of [
    ["mcp__github__create_issue", undefined, "mcp"],
    ["mcp_fs_read_file", undefined, "mcp"],
    ["Bash", undefined, "builtin"],
    ["read_file", { mcp_context: { server: "fs" } }, "mcp"],
    ["read_file", { mcp_context: null }, "builtin"],
    [null, undefined, "builtin"],
    ["mcp", undefined, "builtin"],
    ["mcp_", undefined, "builtin"],
  ]) {
    it(`(${JSON.stringify(tool)}, ${JSON.stringify(native)}) -> ${expected}`, () => {
      assert.equal(classifyCallClass(tool, native), expected);
    });
  }
});

describe("coercion primitives never throw", () => {
  it("asObject returns plain objects, {} for anything else", () => {
    assert.deepEqual(asObject(null), {});
    assert.deepEqual(asObject("s"), {});
    assert.deepEqual(asObject([1]), {});
    assert.deepEqual(asObject({ a: 1 }), { a: 1 });
  });

  it("asStringOrNull keeps strings, null otherwise", () => {
    assert.equal(asStringOrNull("x"), "x");
    assert.equal(asStringOrNull(5), null);
  });

  it("asString keeps strings, falls back otherwise", () => {
    assert.equal(asString("x", "d"), "x");
    assert.equal(asString(undefined, "d"), "d");
  });
});

describe("makeEvent stamps the version and omits absent response", () => {
  const meta = {
    agent: "t",
    native_event: "X",
    integration_mode: "external_hook",
    primary_gate_present: true,
    passthrough: {},
  };

  it("includes response only when defined", () => {
    const withResp = makeEvent({
      event: "post_tool",
      tool: "Bash",
      input: {},
      response: "out",
      this_call_vetoable: true,
      meta,
    });
    assert.equal(withResp.schema_version, 1);
    assert.equal(withResp.response, "out");
    assert.equal(withResp.this_call_vetoable, true);

    const withoutResp = makeEvent({
      event: "pre_tool",
      tool: "Bash",
      input: {},
      response: undefined,
      this_call_vetoable: false,
      meta,
    });
    assert.ok(!("response" in withoutResp));
    assert.equal(withoutResp.this_call_vetoable, false);
  });
});

describe("normalizeVerdict validates and copies modeled fields", () => {
  it("keeps only the present optional fields", () => {
    assert.deepEqual(normalizeVerdict({ decision: "allow" }), {
      decision: "allow",
    });
    assert.deepEqual(
      normalizeVerdict({
        decision: "deny",
        mutated_input: { a: 1 },
        additional_context: "c",
        reason: "r",
      }),
      {
        decision: "deny",
        mutated_input: { a: 1 },
        additional_context: "c",
        reason: "r",
      },
    );
    assert.deepEqual(normalizeVerdict({ decision: "ask" }), {
      decision: "ask",
    });
  });

  it("throws on an out-of-range decision (fail loud)", () => {
    assert.throws(
      () => normalizeVerdict(/** @type {any} */ ({ decision: "maybe" })),
      /invalid verdict decision/,
    );
  });
});

describe("collectPassthrough drops consumed keys, keeps the rest", () => {
  it("returns the unmodelled remainder", () => {
    assert.deepEqual(collectPassthrough({ a: 1, b: 2 }, new Set(["a"])), {
      b: 2,
    });
  });
});

describe("nativeResponse assembles transport channels", () => {
  it("omits absent optional channels", () => {
    assert.deepEqual(
      nativeResponse({
        transport: "external_hook",
        exit_code: 0,
        enforced: false,
      }),
      { transport: "external_hook", exit_code: 0, enforced: false },
    );
  });

  it("carries stdout, throw_, and fallback when present", () => {
    assert.deepEqual(
      nativeResponse({
        transport: "in_process",
        exit_code: 2,
        enforced: true,
        stdout: { a: 1 },
        throw_: { message: "blocked" },
        fallback: { kind: "config_deny", reason: "mcp", deny_globs: ["*"] },
      }),
      {
        transport: "in_process",
        exit_code: 2,
        enforced: true,
        stdout: { a: 1 },
        throw_: { message: "blocked" },
        fallback: { kind: "config_deny", reason: "mcp", deny_globs: ["*"] },
      },
    );
  });
});

// ─── Forward-compatibility: additive upstream drift is a no-op, never an outage.
describe("forward-compat: unknown events/fields pass through", () => {
  it("claude preserves tool + unknown fields, renders via native event name", () => {
    const native = {
      hook_event_name: "PreCompact",
      tool_name: "QuantumTool",
      tool_input: { known: 1, unknown_key: { nested: true } },
      brand_new_top_level: "keepme",
    };
    const event = claudeAdapter.parse(native);
    assert.equal(event.event, EventKind.UNKNOWN);
    assert.equal(event.tool, "QuantumTool");
    assert.deepEqual(event.input, { known: 1, unknown_key: { nested: true } });
    assert.deepEqual(event.meta.passthrough, { brand_new_top_level: "keepme" });
    const out = claudeAdapter.render({ decision: "deny", reason: "r" }, event);
    assert.equal(out.stdout.hookSpecificOutput.hookEventName, "PreCompact");
    assert.equal(out.exit_code, 2);
    assert.equal(out.enforced, true);
  });

  it("codex falls back to PreToolUse when the native event name is empty", () => {
    const event = codexAdapter.parse({
      version: "1.0.0",
      tool_name: "X",
      tool_input: { a: 1 },
      novel: 2,
    });
    assert.equal(event.event, EventKind.UNKNOWN);
    assert.deepEqual(event.meta.passthrough, { novel: 2 });
    const out = codexAdapter.render({ decision: "deny", reason: "r" }, event);
    assert.equal(out.stdout.hookSpecificOutput.hookEventName, "PreToolUse");
  });

  it("adapters never throw on non-object / array / primitive native input", () => {
    for (const bad of [null, 42, "str", [1, 2], undefined]) {
      assert.doesNotThrow(() => claudeAdapter.parse(bad));
      assert.doesNotThrow(() => codexAdapter.parse(bad));
      assert.doesNotThrow(() => ampAdapter.parse(bad));
    }
  });
});
