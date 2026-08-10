import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
// Namespace import, not a named one: on a node without `registerHooks` a named
// import of it is a link-time SyntaxError that takes the whole file down before
// any test reports.
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("package.json", ROOT), "utf8"),
);
const SUBPATHS = Object.entries(manifest.exports);

// Runs in a CHILD process, one per subject: node caches a module graph for the
// life of a process, so a resolve hook registered after some other test already
// imported the subject records nothing and every assertion over its output
// passes vacuously. A cold process is the only place the graph is observable.
//
// `module.registerHooks` is synchronous and in-thread, which is what lets the
// hook record a resolution the same process then uses. It arrived in Node
// 22.15, above `engines.node` (>=20) — `devEngines.runtime` in package.json
// carries that floor for anyone running the suite.
const RECORDER = `
import { registerHooks } from "node:module";
const root = process.env.PKG_ROOT;
const seen = [];
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (result.url.startsWith(root)) seen.push(result.url.slice(root.length));
    return result;
  },
});
await import(process.env.SUBJECT);
process.stdout.write(JSON.stringify(seen));
`;

/**
 * Every module URL a cold process resolves inside this package while importing
 * `subject`, relative to the package root. Recorded through a real resolve hook
 * rather than read off the source text, because what a consumer pays for is the
 * graph node walks, not the specifiers written in one file.
 * @param {string} subject a specifier resolvable from the package root
 * @returns {string[]}
 */
function resolvedDuring(subject) {
  // Fail by name, not through the child's `registerHooks is not a function`.
  assert.equal(
    typeof nodeModule.registerHooks,
    "function",
    `node ${process.versions.node} has no module.registerHooks; the graph tests need >=22.15 (see devEngines in package.json)`,
  );
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", RECORDER],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PKG_ROOT: ROOT.href,
        SUBJECT: new URL(subject, ROOT).href,
      },
    },
  );
  return JSON.parse(out);
}

describe("subpath exports", () => {
  it("declares a subpath for every entry the manifest names", () => {
    assert.ok(
      SUBPATHS.length > 1,
      "read no subpaths from package.json — every case below would be vacuous",
    );
  });

  for (const [subpath, target] of SUBPATHS) {
    it(`${subpath} resolves to the file it names`, async () => {
      const module = await import(new URL(target.import, ROOT));
      assert.ok(
        Object.keys(module).length > 0,
        `${subpath} resolved to a module with no exports`,
      );
      // The types entry must point at a file that exists, or a consumer's tsc
      // resolves the subpath to `any` and every misuse of it type-checks.
      assert.doesNotThrow(
        () => readFileSync(fileURLToPath(new URL(target.types, ROOT))),
        `${subpath} names a types file that is not there`,
      );
    });
  }

  // The reason /contract exists. A hook process pays every module in the graph
  // it imports, so a barrel that reaches the adapters, the registry and the
  // conformance harness costs a consumer that wanted two enums ~22 ms per tool
  // call. This fails the moment /contract grows an edge to any of them.
  it("/contract reaches no adapter, registry or conformance module", () => {
    const reached = resolvedDuring("./src/control-plane.mjs");
    const forbidden = reached.filter((url) =>
      /^src\/(adapters\/|registry\.mjs|conformance\.mjs|index\.mjs)/u.test(url),
    );
    assert.deepEqual(
      forbidden,
      [],
      `/contract must stay adapter-free; it reached ${forbidden.join(", ")}`,
    );
  });

  // The positive control for the case above. Every module /contract must not
  // reach imports /contract back, so that edge cannot be added to mutate the
  // assertion — what proves it is not vacuous is the recorder seeing those same
  // modules when it is handed the barrel.
  it("the same recorder sees the adapters when handed the barrel", () => {
    const reached = resolvedDuring("./src/index.mjs");
    assert.ok(
      reached.some((url) => url.startsWith("src/adapters/")),
      `the barrel must reach an adapter; recorded ${reached.join(", ")}`,
    );
  });

  it("/contract carries the enums a host renders a verdict from", async () => {
    const contract = await import("../src/control-plane.mjs");
    const barrel = await import("../src/index.mjs");
    for (const name of [
      "Decision",
      "EventKind",
      "normalizeVerdict",
      "makeEvent",
    ]) {
      assert.ok(name in contract, `/contract is missing ${name}`);
      // Same object, not a copy: two frozen enums that drift are two SSOTs.
      assert.equal(
        contract[name],
        barrel[name],
        `${name} differs between /contract and the barrel`,
      );
    }
  });
});
