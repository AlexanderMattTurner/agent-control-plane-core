import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTERS,
  AGENT_IDS,
  adapterFor,
  assertRegistryConsistent,
} from "../src/registry.mjs";
import { STANDARD_META_FIELDS } from "../src/control-plane.mjs";
import { claudeAdapter } from "../src/adapters/claude.mjs";
import { codexAdapter } from "../src/adapters/codex.mjs";
import { ampAdapter } from "../src/adapters/amp.mjs";
import { geminiAdapter } from "../src/adapters/gemini.mjs";

// The shipped adapters, imported directly — the SSOT of "what the package
// ships". Driving the test from these (not a re-typed id list) means enrolling a
// new adapter in the registry without adding it here fails the bijection check,
// and adding it here without enrolling it fails too.
const SHIPPED = [claudeAdapter, codexAdapter, ampAdapter, geminiAdapter];

describe("adapter registry", () => {
  it("resolves every shipped adapter by its own AGENT id", () => {
    for (const adapter of SHIPPED) {
      assert.equal(
        adapterFor(adapter.AGENT),
        adapter,
        `adapterFor(${JSON.stringify(adapter.AGENT)}) did not resolve its adapter`,
      );
    }
  });

  it("registry keys are exactly the shipped adapters' AGENT ids (bijection)", () => {
    assert.deepEqual([...AGENT_IDS].sort(), SHIPPED.map((a) => a.AGENT).sort());
    assert.deepEqual(
      Object.keys(ADAPTERS).sort(),
      SHIPPED.map((a) => a.AGENT).sort(),
    );
  });

  it("AGENT_IDS is derived from ADAPTERS (no drift between the two)", () => {
    assert.deepEqual([...AGENT_IDS], Object.keys(ADAPTERS));
  });

  it("every registry entry's key equals its adapter's AGENT", () => {
    for (const [id, adapter] of Object.entries(ADAPTERS)) {
      assert.equal(adapter.AGENT, id);
    }
  });

  it("adapterFor throws (fail loud) on an unknown id — never a silent default", () => {
    assert.throws(
      () => adapterFor("nonesuch"),
      /no adapter for agent id "nonesuch"/,
    );
    // The message lists the known ids so a misconfiguration is diagnosable.
    for (const id of AGENT_IDS) {
      assert.throws(() => adapterFor("nonesuch"), new RegExp(id));
    }
  });

  it("adapterFor throws on a prototype-member id — never resolves an inherited function", () => {
    // Class-kill guard: a bare `ADAPTERS[id]` index would resolve `constructor`
    // to the Object function (!== undefined), bypassing the fail-loud guard and
    // handing back a non-adapter. Every prototype key an id could name must throw.
    for (const proto of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
      "isPrototypeOf",
    ]) {
      assert.throws(() => adapterFor(proto), /no adapter for agent id/, proto);
    }
  });

  it("assertRegistryConsistent throws when a key disagrees with its adapter's AGENT", () => {
    // Non-vacuity: a mismatched map must be rejected, so a real drift can't ship.
    assert.throws(
      () => assertRegistryConsistent({ wrongid: claudeAdapter }),
      /id "wrongid" resolves adapter whose AGENT is "claude"/,
    );
    // And the real, consistent registry passes.
    assert.doesNotThrow(() => assertRegistryConsistent(ADAPTERS));
  });

  it("ADAPTERS and AGENT_IDS are frozen", () => {
    assert.ok(Object.isFrozen(ADAPTERS));
    assert.ok(Object.isFrozen(AGENT_IDS));
  });
});

// The EventMeta fields every adapter must map, checked adapter by adapter rather
// than per adapter's own tests: each adapter hand-copied these, the gemini copy
// omitted `permission_mode`, and a guardrail keying on `event.meta.permission_mode`
// then read `undefined` for gemini alone while claude and codex answered.
describe("every adapter maps the standard EventMeta fields", () => {
  // One payload for all four hosts: the standard fields are top-level in every
  // native protocol. The event name is claude/codex's, so gemini and amp take
  // their unrecognized-event branches — the mapping must hold there too.
  const native = {
    hook_event_name: "PreToolUse",
    tool: "Bash",
    tool_name: "Bash",
    session_id: "s1",
    cwd: "/w",
    permission_mode: "acceptEdits",
    transcript_path: "/t.jsonl",
  };
  const expected = {
    session_id: "s1",
    cwd: "/w",
    permission_mode: "acceptEdits",
    transcript_path: "/t.jsonl",
  };

  it("STANDARD_META_FIELDS is exactly what this test drives", () => {
    assert.deepEqual(
      [...STANDARD_META_FIELDS].sort(),
      Object.keys(expected).sort(),
    );
  });

  for (const adapter of SHIPPED) {
    it(`${adapter.AGENT} maps all of them, and none reaches passthrough`, () => {
      const { meta } = adapter.parse(native);
      for (const field of STANDARD_META_FIELDS) {
        assert.equal(
          meta[field],
          expected[field],
          `${adapter.AGENT} dropped ${field}`,
        );
        // A mapped field must not ALSO ride along unmodelled: a consumer reading
        // passthrough would see the same value under a second name.
        assert.equal(
          Object.hasOwn(meta.passthrough, field),
          false,
          `${adapter.AGENT} duplicated ${field} into passthrough`,
        );
      }
    });

    it(`${adapter.AGENT} leaves a non-string standard field absent`, () => {
      const { meta } = adapter.parse({ ...native, cwd: 42, session_id: null });
      assert.equal("cwd" in meta, false);
      assert.equal("session_id" in meta, false);
    });
  }
});
