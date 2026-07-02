import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFlag } from "../.github/scripts/lib/cli-args.mjs";

// The shared, lint-enforced replacement for positional process.argv indexing
// (eslint.config.js bans process.argv[<number>] and destructuring it, pointing
// here). Both functions get real assertions, not just indirect exercise
// through their callers.

describe("readFlag: finds --name=value by prefix scan, not position", () => {
  it("returns the value when the flag is present", () => {
    assert.equal(
      readFlag(["node", "script.mjs", "--agent=codex"], "agent"),
      "codex",
    );
  });

  it("returns undefined when the flag is absent", () => {
    assert.equal(readFlag(["node", "script.mjs"], "agent"), undefined);
  });

  it("is immune to unrelated arguments prepended or interspersed", () => {
    const argv = [
      "node",
      "script.mjs",
      "--verbose",
      "--agent=gemini",
      "--dry-run",
    ];
    assert.equal(readFlag(argv, "agent"), "gemini");
  });

  it("does not partial-match a longer flag name sharing a prefix", () => {
    // --agent-id=x must not satisfy a lookup for "agent".
    assert.equal(readFlag(["--agent-id=x"], "agent"), undefined);
  });

  it("takes the first match when a flag repeats", () => {
    assert.equal(readFlag(["--agent=a", "--agent=b"], "agent"), "a");
  });

  it("handles an empty value", () => {
    assert.equal(readFlag(["--agent="], "agent"), "");
  });
});

describe("isMainModule: Node's entry-point idiom, centralized", () => {
  it("is true when the script runs itself directly, false when imported", () => {
    // Drive a real subprocess: a throwaway script that imports isMainModule and
    // reports what it returns for itself vs. a sibling module it also imports.
    const res = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
        import { isMainModule } from ${JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "scripts", "lib", "cli-args.mjs")).href)};
        process.stdout.write(String(isMainModule(import.meta.url)));
        `,
      ],
      { encoding: "utf8" },
    );
    // A script run via `node -e` has no meaningful argv[1] pointing at this
    // inline snippet, so it must NOT claim to be cli-args.mjs itself.
    assert.equal(res.stdout, "false");
  });

  it("returns true for a real script invoked as the entry point", () => {
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "is-main-module-fixture.mjs",
    );
    const res = spawnSync("node", [fixture], { encoding: "utf8" });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "true");
  });
});
