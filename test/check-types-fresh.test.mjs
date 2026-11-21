// Behavioral tests for the committed-declaration gate. The real script runs in
// a real scratch git repository, so `git diff`'s own verdict decides every
// case; only `pnpm` is stubbed, because varying what the build WRITES is the
// whole input domain. Every assertion reads an observable: the exit status, the
// diff on stdout, and the stderr a reader of the job log sees.
//
// Lives here rather than beside the script: `pnpm test` globs `test/*.test.mjs`
// and nothing runs `.github/scripts/*.test.mjs`, so a test placed there would
// report nothing while looking like coverage.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../.github/scripts/check-types-fresh.sh",
);

const COMMITTED = "export const NATIVE_ASK_TIER: false;\n";

/**
 * Run the gate over a repository whose committed `types/` holds {@link COMMITTED},
 * against a `pnpm` stub that does `build`.
 * @param {{writes?: string, adds?: string, fails?: boolean}} build what the stub
 *   leaves behind, and whether it reports failure. An omitted `writes` writes
 *   nothing at all, which is what a build whose source module was removed does;
 *   `adds` writes a SECOND, never-committed file.
 */
function gate(build) {
  const root = mkdtempSync(join(tmpdir(), "types-fresh-"));
  const git = (...args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8" });

  mkdirSync(join(root, "types"));
  writeFileSync(join(root, "types/codex.d.mts"), COMMITTED);
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "baseline");

  // A `pnpm` that records it ran, then leaves the tree in the state under test.
  const bin = join(root, "bin");
  mkdirSync(bin);
  const stub = [
    "#!/usr/bin/env bash",
    `echo "$*" >> ${JSON.stringify(join(root, "pnpm-argv"))}`,
    // %b, not %s: bash leaves `\n` inside a double-quoted word alone, so %s
    // would write a literal backslash-n and no trailing newline.
    ...(build.writes === undefined
      ? []
      : [
          `printf %b ${JSON.stringify(build.writes)} > ${JSON.stringify(join(root, "types/codex.d.mts"))}`,
        ]),
    ...(build.adds === undefined
      ? []
      : [
          `printf %b ${JSON.stringify(build.adds)} > ${JSON.stringify(join(root, "types/added.d.mts"))}`,
        ]),
    `exit ${build.fails ? 1 : 0}`,
    "",
  ].join("\n");
  writeFileSync(join(bin, "pnpm"), stub, { mode: 0o755 });

  const res = spawnSync("bash", [SCRIPT], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const readOrEmpty = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  return {
    status: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    argv: readOrEmpty(join(root, "pnpm-argv")),
    restored: readOrEmpty(join(root, "types/codex.d.mts")),
  };
}

describe("the committed-declaration gate", () => {
  it("passes when the build reproduces the committed bytes", () => {
    const run = gate({ writes: COMMITTED });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "");
    // Without this, a gate that never built would also pass this case.
    assert.match(run.argv, /\bbuild\b/u);
  });

  it("fails and prints the drift when the build writes other bytes", () => {
    const run = gate({ writes: "export const NATIVE_ASK_TIER: true;\n" });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^\+export const NATIVE_ASK_TIER: true;$/mu);
    assert.match(run.stdout, /^-export const NATIVE_ASK_TIER: false;$/mu);
    assert.match(run.stderr, /types\/ is stale/u);
  });

  // The case a plain `git diff` cannot see. `git diff` reads the index, so a
  // new source module whose declaration was never committed leaves an UNTRACKED
  // file and the gate would report success over an incomplete `types/`.
  it("fails on a declaration the build adds but nobody committed", () => {
    const run = gate({
      writes: COMMITTED,
      adds: "export const ADDED: true;\n",
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /types\/added\.d\.mts/u);
    assert.match(run.stderr, /types\/ is stale/u);
  });

  // The removal direction. `tsc` writes over `types/` and never deletes from
  // it, so a declaration for a source module that was REMOVED stays behind,
  // tracked and byte-identical — and a diff of the rebuilt tree calls that
  // clean while the package still publishes an API for code that is gone. The
  // stub writes nothing, which is exactly what that build does.
  it("fails on a declaration whose source module is gone", () => {
    const run = gate({});
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^-export const NATIVE_ASK_TIER: false;$/mu);
    assert.match(run.stderr, /types\/ is stale/u);
  });

  // The build failing is NOT a clean tree. A gate that skipped straight to the
  // diff would find nothing changed and report success, so this case pins the
  // order as well as the status.
  it("fails on a build that did not run to completion", () => {
    const run = gate({ fails: true });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /types\/ cannot be verified/u);
    assert.doesNotMatch(run.stderr, /types\/ is stale/u);
    // The gate empties `types/` before it builds, so a build that died must
    // hand the committed tree back rather than leave the caller with nothing.
    assert.equal(run.restored, COMMITTED);
  });
});
