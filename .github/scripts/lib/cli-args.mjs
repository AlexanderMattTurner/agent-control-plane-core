// Shared CLI-argument helpers for the repo's Node scripts. The point: a bare
// numeric index into process.argv (argv[2], argv[3], …) is fragile — it has no
// self-description and silently reads the wrong value if any argument is ever
// prepended to the command line, by us in a future edit or by a host we don't
// fully control. eslint.config.js bans raw numeric process.argv indexing
// repo-wide via no-restricted-syntax; this module is the one place that
// encapsulates the two legitimate exceptions to that rule.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Find a `--name=value` flag in argv (by prefix scan, not position) and return
 * its value, or undefined if absent. Immune to unrelated arguments — ours or a
 * host's — being prepended or interspersed.
 * @param {string[]} argv
 * @param {string} name flag name without the leading `--` or trailing `=`
 * @returns {string|undefined}
 */
export function readFlag(argv, name) {
  const prefix = `--${name}=`;
  const arg = argv.find((a) => a.startsWith(prefix));
  return arg === undefined ? undefined : arg.slice(prefix.length);
}

/**
 * The one sanctioned use of `process.argv[1]` in this repo: Node's own ESM
 * "is this the entry point" idiom (argv[1] is guaranteed by Node to be the
 * invoked script's path, not a user-supplied value a host could shift) — there
 * is no argv-free way to ask this in the Node versions this repo targets.
 * `argv[1]` is not always a real file on disk (`node -e`/`--eval`, a REPL) —
 * `realpathSync` throws there; that case is "not the entry point" (false), not
 * a crash.
 * @param {string} importMetaUrl the caller's `import.meta.url`
 * @returns {boolean}
 */
export function isMainModule(importMetaUrl) {
  if (!process.argv[1]) return false; // eslint-disable-line no-restricted-syntax -- Node's own entry-point idiom; see doc comment above.
  try {
    const invoked = realpathSync(process.argv[1]); // eslint-disable-line no-restricted-syntax -- Node's own entry-point idiom; see doc comment above.
    return invoked === realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}
