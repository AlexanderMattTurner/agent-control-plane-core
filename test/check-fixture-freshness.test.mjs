import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseVersion,
  isNewer,
  checkFreshness,
} from "../.github/scripts/check-fixture-freshness.mjs";

// The fixture-freshness check is the deterministic, secret-free tier of
// live-conformance. These tests pin its version math and drift logic with a
// stubbed registry (no network), and assert the shipped SSOT stays well-formed.

describe("parseVersion drops prerelease/build and coerces junk to 0", () => {
  for (const [input, expected] of [
    ["1.2.3", [1, 2, 3]],
    ["2.1.170", [2, 1, 170]],
    ["1.2.3-beta.1", [1, 2, 3]],
    ["1.2.3+build.5", [1, 2, 3]],
    ["0.142.4-alpha.2+sha", [0, 142, 4]],
    ["2.0", [2, 0, 0]],
    ["garbage", [0, 0, 0]],
    ["", [0, 0, 0]],
  ]) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      assert.deepEqual(parseVersion(input), expected);
    });
  }
});

describe("isNewer compares major, then minor, then patch", () => {
  for (const [latest, captured, expected] of [
    ["1.2.4", "1.2.3", true],
    ["1.3.0", "1.2.9", true],
    ["2.0.0", "1.9.9", true],
    ["1.2.3", "1.2.3", false],
    ["1.2.2", "1.2.3", false],
    ["1.0.0", "2.0.0", false],
    ["1.2.3-rc.1", "1.2.3", false], // prerelease coerces to 1.2.3, not newer
    ["1.2.4-rc.1", "1.2.3", true], // prerelease of a higher release is newer
    ["1.2.4+build.9", "1.2.3", true], // build metadata ignored
    ["garbage", "1.2.3", false], // uncoercible latest → 0.0.0, not newer
  ]) {
    it(`isNewer(${latest}, ${captured}) === ${expected}`, () => {
      assert.equal(isNewer(latest, captured), expected);
    });
  }
});

describe("checkFreshness flags drift and skips rolling releases", () => {
  const config = {
    adapters: [
      {
        agent: "claude",
        package: "@anthropic-ai/claude-code",
        versioning: "semver",
        captured_version: "2.1.170",
      },
      {
        agent: "codex",
        package: "@openai/codex",
        versioning: "semver",
        captured_version: "0.142.4",
      },
      {
        agent: "amp",
        package: "@sourcegraph/amp",
        versioning: "rolling",
        captured_version: "unversioned (rolling release)",
      },
    ],
  };

  it("marks a semver adapter drifted only when a newer version shipped", async () => {
    const latestByPkg = {
      "@anthropic-ai/claude-code": "2.1.170", // unchanged → no drift
      "@openai/codex": "0.143.0", // newer → drift
    };
    const fetchLatest = async (pkg) => latestByPkg[pkg];
    const results = await checkFreshness(config, fetchLatest);

    assert.deepEqual(results, [
      {
        agent: "claude",
        package: "@anthropic-ai/claude-code",
        captured: "2.1.170",
        latest: "2.1.170",
        drifted: false,
        rolling: false,
      },
      {
        agent: "codex",
        package: "@openai/codex",
        captured: "0.142.4",
        latest: "0.143.0",
        drifted: true,
        rolling: false,
      },
      {
        agent: "amp",
        package: "@sourcegraph/amp",
        captured: "unversioned (rolling release)",
        latest: null,
        drifted: false,
        rolling: true,
      },
    ]);
  });

  it("never fetches for a rolling adapter", async () => {
    const rollingOnly = { adapters: [config.adapters[2]] };
    const fetchLatest = async () => {
      throw new Error("fetch must not be called for a rolling adapter");
    };
    const results = await checkFreshness(rollingOnly, fetchLatest);
    assert.equal(results[0].rolling, true);
    assert.equal(results[0].latest, null);
  });
});

describe("shipped SSOT is well-formed", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(
    readFileSync(join(here, "..", "config", "live-conformance.json"), "utf8"),
  );

  it("every adapter declares the fields both conformance tiers need", () => {
    assert.ok(Array.isArray(config.adapters) && config.adapters.length >= 3);
    for (const a of config.adapters) {
      assert.equal(typeof a.agent, "string");
      assert.equal(typeof a.package, "string");
      assert.ok(["semver", "rolling"].includes(a.versioning));
      assert.equal(typeof a.captured_version, "string");
      assert.equal(typeof a.event_name, "string");
      assert.equal(typeof a.secret, "string");
    }
  });

  it("covers exactly the four shipped adapters", () => {
    assert.deepEqual(config.adapters.map((a) => a.agent).sort(), [
      "amp",
      "claude",
      "codex",
      "gemini",
    ]);
  });
});
