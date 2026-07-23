import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codexAdapter,
  canEnforce,
  DEFAULT_DENY_REASON,
  MIN_ENFORCING_VERSION,
} from "../src/adapters/codex.mjs";
import { runAdapterConformance } from "../src/conformance.mjs";

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

  // Drift guard: derive the boundary versions from MIN_ENFORCING_VERSION so a
  // threshold bump can't leave the hardcoded table above asserting a stale
  // boundary. At-threshold enforces; the highest patch of the prior minor does not.
  it("derives the boundary from MIN_ENFORCING_VERSION", () => {
    const [maj, min] = MIN_ENFORCING_VERSION;
    assert.equal(canEnforce(`${maj}.${min}.0`), true);
    assert.equal(canEnforce(`${maj}.${min - 1}.999`), false);
  });
});
