// npm/pnpm `prepare` entry — runs on `pnpm install` in a dev checkout AND when
// a consumer installs this package as a git dependency (the registry tarball
// path uses prepublishOnly instead). The two environments need different work:
//
// - Dev checkout (a real git repo): wire the repo's commit hooks. A consumer's
//   extracted tarball has no .git, where `git config` exits 128 and would fail
//   the consumer's whole install.
// - Both: emit types/ with tsc so the package.json "types" targets exist —
//   a git-dep install never runs prepublishOnly, so without this a consumer's
//   typecheck finds the exports map pointing at missing .d.mts files.
//
// tsc resolves from node_modules/.bin, which npm/pnpm put on PATH for
// lifecycle scripts.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

if (existsSync(new URL("../.git", import.meta.url))) {
  execFileSync("git", ["config", "core.hooksPath", ".hooks"], {
    stdio: "inherit",
  });
}
execFileSync("tsc", ["-p", "tsconfig.build.json"], { stdio: "inherit" });
