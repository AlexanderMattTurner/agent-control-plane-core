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
  TOOL_ALIASES,
  canonicalTool,
  lookup,
  assertAliasTargetsModeled,
  makeEvent,
  normalizeVerdict,
  sanitizeVerdict,
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
    assert.ok(Object.isFrozen(TOOL_ALIASES));
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
    assert.deepEqual(TOOL_ALIASES, { run_shell_command: "Bash" });
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

describe("tool identity: canonicalTool normalizes aliases, passes through the rest", () => {
  it("maps a known native alias to its canonical modeled tool", () => {
    assert.equal(canonicalTool("run_shell_command"), "Bash");
  });

  it("passes an unknown / already-canonical tool through verbatim", () => {
    assert.equal(canonicalTool("Bash"), "Bash");
    assert.equal(
      canonicalTool("mcp__github__create_issue"),
      "mcp__github__create_issue",
    );
    assert.equal(canonicalTool("some_novel_tool"), "some_novel_tool");
  });

  it("passes null (a non-tool event) through as null", () => {
    assert.equal(canonicalTool(null), null);
  });

  // Class-kill guard: an untrusted tool name that collides with an
  // Object.prototype member must pass through verbatim, never resolve to the
  // inherited function. Parametrized over every prototype key an attacker could
  // name; a regression to a bare `TOOL_ALIASES[tool]` index turns each into a
  // function and fails here.
  for (const proto of [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
    "isPrototypeOf",
  ]) {
    it(`passes the prototype-member name ${JSON.stringify(proto)} through verbatim`, () => {
      assert.equal(canonicalTool(proto), proto);
      assert.equal(typeof canonicalTool(proto), "string");
    });
  }

  it("every alias target is a modeled tool", () => {
    for (const target of Object.values(TOOL_ALIASES))
      assert.ok(
        MODELED_TOOLS.includes(target),
        `alias target ${target} not modeled`,
      );
  });

  it("assertAliasTargetsModeled accepts modeled targets, throws on a non-modeled one", () => {
    assert.doesNotThrow(() => assertAliasTargetsModeled({ foo: "Bash" }));
    assert.throws(
      () => assertAliasTargetsModeled({ foo: "NotAModeledTool" }),
      /tool alias target .* is not a modeled tool/,
    );
  });
});

describe("lookup: own-property map access ignores prototype keys", () => {
  it("returns an own value", () => {
    assert.equal(lookup({ Bash: "ok" }, "Bash"), "ok");
  });

  it("returns undefined for every inherited prototype member", () => {
    for (const proto of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
      "isPrototypeOf",
    ])
      assert.equal(lookup({ Bash: "ok" }, proto), undefined, proto);
  });

  it("returns an own value even when it shadows a prototype name", () => {
    assert.equal(lookup({ toString: "shadowed" }, "toString"), "shadowed");
  });
});

describe("makeEvent fails loud on an internally-malformed event", () => {
  const goodMeta = {
    agent: "claude",
    native_event: "PreToolUse",
    integration_mode: "external_hook",
    primary_gate_present: true,
    passthrough: {},
  };
  const base = {
    tool: "Bash",
    input: {},
    this_call_vetoable: true,
    meta: goodMeta,
  };

  it("accepts every modeled event kind, including UNKNOWN", () => {
    for (const kind of Object.values(EventKind))
      assert.doesNotThrow(() => makeEvent({ ...base, event: kind }));
  });

  it("throws on an unmodeled event kind", () => {
    assert.throws(
      () => makeEvent({ ...base, event: "pre-tool" }),
      /unmodeled event kind/,
    );
  });

  it("throws on a non-boolean this_call_vetoable (a fail-open seam)", () => {
    assert.throws(
      () =>
        makeEvent({
          ...base,
          event: EventKind.PRE_TOOL,
          this_call_vetoable: undefined,
        }),
      /this_call_vetoable must be a boolean/,
    );
  });
});

describe("classifyCallClass distinguishes an object mcp_context from an array", () => {
  it("a plain-object mcp_context marks MCP", () => {
    assert.equal(
      classifyCallClass("Bash", { mcp_context: { server: "x" } }),
      CallClass.MCP,
    );
  });

  it("an array-valued mcp_context is NOT MCP (no over-classify)", () => {
    assert.equal(
      classifyCallClass("Bash", { mcp_context: [] }),
      CallClass.BUILTIN,
    );
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
        mutated_output: "sanitized",
        additional_context: "c",
        reason: "r",
      }),
      {
        decision: "deny",
        mutated_input: { a: 1 },
        mutated_output: "sanitized",
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

describe("sanitizeVerdict hardens an untrusted verdict before render", () => {
  // A visible, deterministic sanitizer so tests assert exact equality on what
  // ran through it (identity would make "was it sanitized?" unobservable).
  const tag = (s) => `<${s}>`;
  const identity = (s) => s;

  it("passes a valid verdict through, sanitizing only the prose fields", () => {
    assert.deepEqual(
      sanitizeVerdict(
        {
          decision: "deny",
          reason: "bad command",
          additional_context: "ctx",
          mutated_input: { command: "echo safe" },
          mutated_output: "raw <output> untouched",
        },
        tag,
      ),
      {
        decision: "deny",
        mutated_input: { command: "echo safe" },
        mutated_output: "raw <output> untouched",
        additional_context: "<ctx>",
        reason: "<bad command>",
      },
    );
  });

  it("clamps an invalid decision to ask, with an observable clamp note", () => {
    assert.deepEqual(sanitizeVerdict({ decision: "maybe" }, identity), {
      decision: "ask",
      reason:
        '[control-plane: invalid verdict decision "maybe" clamped to "ask"]',
    });
  });

  it("appends the clamp note after an existing (sanitized) reason", () => {
    assert.deepEqual(sanitizeVerdict({ decision: "block", reason: "r" }, tag), {
      decision: "ask",
      reason:
        '<r> [control-plane: invalid verdict decision <"block"> clamped to "ask"]',
    });
  });

  it("clamps a non-object / missing-decision verdict to ask", () => {
    assert.deepEqual(sanitizeVerdict(null, identity), {
      decision: "ask",
      reason:
        '[control-plane: invalid verdict decision undefined clamped to "ask"]',
    });
  });

  it("clamps a BigInt decision to ask instead of throwing (JSON.stringify would throw)", () => {
    const out = sanitizeVerdict({ decision: 10n }, identity);
    assert.equal(out.decision, "ask");
    assert.match(out.reason, /clamped to "ask"/);
  });

  it("drops a non-object mutated_input (never blanks a tool call with {})", () => {
    for (const bad of ["rm -rf /", [1], null, 42]) {
      assert.deepEqual(
        sanitizeVerdict({ decision: "allow", mutated_input: bad }, identity),
        { decision: "allow" },
      );
    }
  });

  it("drops a non-string prose field instead of feeding it to the sanitizer", () => {
    assert.deepEqual(
      sanitizeVerdict(
        { decision: "allow", reason: 42, additional_context: { a: 1 } },
        tag,
      ),
      { decision: "allow" },
    );
  });

  it("throws a TypeError when sanitizeText is not a function", () => {
    assert.throws(() => sanitizeVerdict({ decision: "allow" }, undefined), {
      name: "TypeError",
      message: /requires a sanitizeText/,
    });
  });

  it("throws when sanitizeText returns a non-string (a sanitizer that eats the value)", () => {
    assert.throws(
      () => sanitizeVerdict({ decision: "deny", reason: "r" }, () => undefined),
      { name: "TypeError", message: /returned a non-string for reason/ },
    );
  });

  it("never mutates the input verdict", () => {
    const input = Object.freeze({
      decision: "maybe",
      reason: "r",
      mutated_input: Object.freeze({ a: 1 }),
    });
    const out = sanitizeVerdict(input, tag);
    assert.notEqual(out, input);
    assert.deepEqual(input, {
      decision: "maybe",
      reason: "r",
      mutated_input: { a: 1 },
    });
    assert.equal(out.mutated_input, input.mutated_input);
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

  it("carries stdout when present", () => {
    assert.deepEqual(
      nativeResponse({
        transport: "in_process",
        exit_code: 2,
        enforced: true,
        stdout: { a: 1 },
      }),
      {
        transport: "in_process",
        exit_code: 2,
        enforced: true,
        stdout: { a: 1 },
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
