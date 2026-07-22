// Detect when an adapter's golden fixtures may have gone stale.
//
// The fixtures in `src/fixtures/*.json` are hand-authored snapshots of each
// agent's real native hook payload. They rot SILENTLY: an agent ships a new
// version that changes its hook JSON, and the fixture (and the adapter built to
// it) drifts from reality with nothing to catch it — the "golden fixtures rot
// silently" failure this guards against.
//
// This is the deterministic, secret-free half of live-conformance: it compares
// the CLI version each fixture set is known-good against
// (`config/live-conformance.json`) to the version currently published on npm. A
// newer published version does NOT prove the fixture rotted, but it is the
// signal to re-capture against that version and re-run adapter conformance. The
// live, LLM-driven capture that would PROVE a match needs per-agent credentials
// and is the follow-up documented in `docs/live-conformance.md`.
//
// Self-contained (node builtins + fetch): no in-repo imports, so a trusted copy
// runs standalone in CI.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_PATH = join(REPO_ROOT, "config", "live-conformance.json");

/**
 * Parse a semver string to `[major, minor, patch]`, dropping any prerelease or
 * build metadata (`1.2.3-beta.1+sha` → `[1,2,3]`) via `semver.coerce`. Anything
 * `coerce` can't resolve to a valid version (missing, empty, garbage) yields
 * `[0, 0, 0]` so a malformed version never throws — this feeds a best-effort
 * advisory check, not a gate that should crash on odd input.
 * @param {unknown} v
 * @returns {[number, number, number]}
 */
export function parseVersion(v) {
  const c = semver.coerce(String(v));
  return c === null ? [0, 0, 0] : [c.major, c.minor, c.patch];
}

/**
 * True when `latest` is a strictly higher release than `captured`. Both sides
 * are coerced to their release core first, so prerelease tags are ignored
 * (`1.2.3-rc.1` is NOT newer than `1.2.3`) and an uncoercible version compares
 * as `0.0.0`.
 * @param {string} latest
 * @param {string} captured
 * @returns {boolean}
 */
export function isNewer(latest, captured) {
  const a = parseVersion(latest).join(".");
  const b = parseVersion(captured).join(".");
  return semver.gt(a, b);
}

/**
 * Fetch the latest published version of an npm package from the public registry
 * (no auth). Throws on a non-OK response or a missing version field.
 * @param {string} pkg
 * @returns {Promise<string>}
 */
export async function npmLatest(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`);
  if (!res.ok) throw new Error(`npm registry ${res.status} for ${pkg}`);
  const body = await res.json();
  if (typeof body.version !== "string")
    throw new Error(`no version field in npm response for ${pkg}`);
  return body.version;
}

/**
 * Compare each adapter's known-good CLI version to the latest published one.
 * A `versioning: "rolling"` adapter (e.g. Amp, no semver release story) is
 * reported informationally without a drift verdict — comparing against a
 * moving `latest` would flag perpetual, meaningless drift. `fetchLatest` is
 * injected so the check is unit-testable without the network.
 * @param {{ adapters: Array<{ agent: string, package: string, captured_version: string, versioning: string }> }} config
 * @param {(pkg: string) => Promise<string>} fetchLatest
 * @returns {Promise<Array<{ agent: string, package: string, captured: string, latest: string|null, drifted: boolean, rolling: boolean }>>}
 */
export async function checkFreshness(config, fetchLatest) {
  const results = [];
  for (const a of config.adapters) {
    if (a.versioning === "rolling") {
      results.push({
        agent: a.agent,
        package: a.package,
        captured: a.captured_version,
        latest: null,
        drifted: false,
        rolling: true,
      });
      continue;
    }
    const latest = await fetchLatest(a.package);
    results.push({
      agent: a.agent,
      package: a.package,
      captured: a.captured_version,
      latest,
      drifted: isNewer(latest, a.captured_version),
      rolling: false,
    });
  }
  return results;
}

/**
 * Report freshness results and decide the process exit code: 1 when ANY adapter
 * drifted (a newer CLI shipped), else 0. The write/exit boundary is separated
 * from `checkFreshness`'s version math so the GATE — the thing that actually
 * breaks CI and forces a re-capture — is unit-testable without a subprocess or
 * the network. Writers are injected so a test can capture the stdout log and the
 * stderr drift banner.
 * @param {{ agent: string, package: string, captured: string, latest: string, drifted: boolean, rolling: boolean }[]} results
 * @param {{ write: (s: string) => void }} [out]
 * @param {{ write: (s: string) => void }} [err]
 * @returns {number} process exit code (0 fresh, 1 drifted)
 */
export function reportFreshness(
  results,
  out = process.stdout,
  err = process.stderr,
) {
  let drift = false;
  for (const r of results) {
    const tag = r.rolling ? "rolling" : r.drifted ? "DRIFT" : "ok";
    const latest = r.rolling ? "n/a (rolling release)" : r.latest;
    out.write(
      `[${tag}] ${r.agent} (${r.package}): known-good ${r.captured}, latest ${latest}\n`,
    );
    if (r.drifted) drift = true;
  }
  if (drift) {
    err.write(
      "\nA newer CLI has shipped for a drifted adapter. Re-capture its fixtures against the latest version and re-run adapter conformance. See docs/live-conformance.md.\n",
    );
    return 1;
  }
  return 0;
}

// CLI entry — runs only when executed directly, not when imported by tests.
// Node's own "is this the entry point" idiom (argv[1] is guaranteed by Node to
// be the invoked script's path, not a user-supplied value) — the file stays
// self-contained on purpose (see header), so this can't reuse
// lib/cli-args.mjs's isMainModule() the way the other scripts do.
// eslint-disable-next-line no-restricted-syntax -- Node's own entry-point idiom; see comment above.
const invoked = process.argv[1] && realpathSync(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const results = await checkFreshness(config, npmLatest);
  process.exit(reportFreshness(results));
}
