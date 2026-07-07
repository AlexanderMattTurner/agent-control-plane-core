import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ADAPTERS,
  AGENT_IDS,
  adapterFor,
  assertRegistryConsistent,
} from "../src/registry.mjs";
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
